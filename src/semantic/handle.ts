import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { TriliumClientHandle } from "../client.js";
import { EMBEDDING_PROVIDER_ID, EmbeddingProviderHandle } from "./embedding-provider.js";
import { searchSemantic } from "./search.js";
import { SemanticIndexStore } from "./store.js";
import { runIncrementalSync } from "./sync.js";
import type { IndexIdentity, SemanticMatch, SemanticSearchConfig } from "./types.js";
import { DEFAULT_SEMANTIC_SEARCH_CONFIG, identitiesMatch } from "./types.js";

export type SemanticSearchPluginConfig = {
  enabled?: boolean;
  indexPath?: string;
  embedding?: {
    modelPath?: string;
    // Plain string or a SecretRef object, same shape/resolution path as
    // index.ts's top-level apiToken -- see resolveApiKey below.
    apiKey?: unknown;
  };
};

// Mirrors index.ts's resolveApiToken (same SecretRef-or-plain-string
// shape, same resolution libraries), but tolerant rather than throwing:
// a missing/unresolvable embedding.apiKey just means the semantic backend
// stays unavailable (fail open) rather than a configuration error worth
// failing plugin setup over.
async function resolveApiKey(api: OpenClawPluginApi, value: unknown): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (!isSecretRef(value)) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  const resolved = await resolveSecretRefValues([value], { config: api.config });
  const [resolvedValue] = resolved.values();
  return typeof resolvedValue === "string" && resolvedValue.length > 0 ? resolvedValue : undefined;
}

export type SemanticSearchHandle = {
  // False whenever the semantic backend couldn't come up for any reason
  // (disabled by config, no embedding.apiKey configured, Node runtime
  // without node:sqlite, sqlite-vec failed to load, ...). `search` still
  // exists and is always safe to call -- it just always resolves to `[]`.
  available: boolean;
  search: (rawSearch: string | undefined, limit: number) => Promise<SemanticMatch[]>;
  dispose: () => Promise<void>;
};

function unavailableHandle(): SemanticSearchHandle {
  return {
    available: false,
    search: async () => [],
    dispose: async () => {},
  };
}

function resolveConfig(raw: SemanticSearchPluginConfig | undefined): SemanticSearchConfig {
  const indexPath =
    raw?.indexPath ??
    path.join(os.homedir(), ".openclaw", "plugins", "trilium", "semantic-index.db");
  return {
    ...DEFAULT_SEMANTIC_SEARCH_CONFIG,
    enabled: raw?.enabled ?? DEFAULT_SEMANTIC_SEARCH_CONFIG.enabled,
    indexPath,
    model: raw?.embedding?.modelPath ?? DEFAULT_SEMANTIC_SEARCH_CONFIG.model,
  };
}

function candidateIdentity(config: SemanticSearchConfig): IndexIdentity {
  return {
    providerId: EMBEDDING_PROVIDER_ID,
    model: config.model,
    dimensions: config.dimensions,
    chunkTokens: config.chunkTokens,
    chunkOverlap: config.chunkOverlap,
  };
}

// Builds the semantic-search backend the same way index.ts builds the
// Trilium client handle: register() stays synchronous, this kicks off
// async setup without awaiting it, and hands back a promise every tool
// execute() can await once and reuse. `clientHandlePromise` is the same
// promise threaded into the note tools -- sync needs the Trilium client
// too, so setup here waits on it internally rather than duplicating
// client construction.
export function createSemanticSearchHandle(
  api: OpenClawPluginApi,
  clientHandlePromise: Promise<TriliumClientHandle>,
): Promise<SemanticSearchHandle> {
  const rawConfig = (
    api.pluginConfig as { semanticSearch?: SemanticSearchPluginConfig } | undefined
  )?.semanticSearch;
  const config = resolveConfig(rawConfig);
  const logger: PluginLogger = api.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  if (!config.enabled) {
    return Promise.resolve(unavailableHandle());
  }

  return setup(api, clientHandlePromise, config, rawConfig?.embedding?.apiKey, logger).catch(
    (err) => {
      logger.warn(
        `semantic search: setup failed, falling back to lexical-only search: ${describe(err)}`,
      );
      return unavailableHandle();
    },
  );
}

async function setup(
  api: OpenClawPluginApi,
  clientHandlePromise: Promise<TriliumClientHandle>,
  config: SemanticSearchConfig,
  rawApiKey: unknown,
  logger: PluginLogger,
): Promise<SemanticSearchHandle> {
  const apiKey = await resolveApiKey(api, rawApiKey);
  if (!apiKey) {
    logger.warn(
      "semantic search: no semanticSearch.embedding.apiKey configured, falling back to lexical-only search",
    );
    return unavailableHandle();
  }

  const opened = await SemanticIndexStore.open(config.indexPath, config.dimensions);
  if (!opened.available) {
    logger.warn(
      `semantic search: index unavailable, falling back to lexical-only search: ${opened.reason}`,
    );
    return unavailableHandle();
  }
  const { store } = opened;

  try {
    return setupWithOpenStore(store, config, apiKey, clientHandlePromise, api, logger);
  } catch (err) {
    store.close();
    throw err;
  }
}

function setupWithOpenStore(
  store: SemanticIndexStore,
  config: SemanticSearchConfig,
  apiKey: string,
  clientHandlePromise: Promise<TriliumClientHandle>,
  api: OpenClawPluginApi,
  logger: PluginLogger,
): SemanticSearchHandle {
  const embeddingProvider = new EmbeddingProviderHandle({
    apiKey,
    model: config.model,
    dimensions: config.dimensions,
    logger,
  });

  const identity = candidateIdentity(config);
  const storedIdentity = store.getIdentity();
  if (!storedIdentity || !identitiesMatch(storedIdentity, identity)) {
    logger.info?.(
      storedIdentity
        ? "semantic search: embedding/chunking config changed, rebuilding index from scratch"
        : "semantic search: no existing index, starting a fresh backfill",
    );
    store.rebuild(identity);
  }

  let syncInFlight = false;
  const runSyncPass = async () => {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
      const { client } = await clientHandlePromise;
      const summary = await runIncrementalSync({
        client,
        store,
        embeddingProvider,
        config,
        logger,
      });
      logger.info?.(
        `semantic search: sync pass complete (fetched=${summary.fetchedNotes}, ` +
          `processed=${summary.processed}, skipped=${summary.skippedUnchanged}, ` +
          `failed=${summary.failed}, notesIndexed=${store.noteCount()})`,
      );
    } catch (err) {
      logger.warn(`semantic search: sync pass failed: ${describe(err)}`);
    } finally {
      syncInFlight = false;
    }
  };

  // Kick off an initial pass in the background rather than blocking tool
  // registration on a full backfill -- the first search after plugin load
  // may simply find nothing semantic yet, which is no worse than the
  // lexical-only behavior this replaces.
  void runSyncPass();

  const interval = setInterval(() => void runSyncPass(), config.syncIntervalMs);
  interval.unref?.();

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    await embeddingProvider.dispose();
    store.close();
  };

  api.lifecycle.registerRuntimeLifecycle({
    id: "trilium-semantic-search",
    description: "Closes the semantic search index and unloads the embedding provider on shutdown.",
    cleanup: () => dispose(),
  });

  return {
    available: true,
    search: (rawSearch, limit) =>
      searchSemantic(
        { store, embeddingProvider, queryTimeoutMs: config.queryTimeoutMs, logger },
        rawSearch,
        limit,
      ),
    dispose,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
