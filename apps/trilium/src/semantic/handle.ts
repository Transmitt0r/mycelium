import os from "node:os";
import path from "node:path";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderConfig,
} from "@mycelium/embed";
import {
  DEFAULT_SEMANTIC_INDEX_CONFIG,
  openSemanticIndex,
  type SemanticIndex,
} from "@mycelium/index";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { TriliumClientHandle } from "../client.js";
import { extractFreeTextTerms } from "./query.js";
import { createTriliumSourceAdapter } from "./source-adapter.js";
import type { SemanticMatch } from "./types.js";

// How often a background incremental sync pass runs. Not part of
// @mycelium/index's own config surface -- it doesn't manage scheduling
// itself, the host does.
const SYNC_INTERVAL_MS = 15 * 60_000;

export type SemanticSearchPluginConfig = {
  enabled?: boolean;
  indexPath?: string;
  embedding?: {
    // "local" is opt-in only -- never the silent default. A prior in-process
    // local-inference attempt (node-llama-cpp, in this plugin's sibling
    // paperless-ngx) was OOM-killed in production on a memory-constrained
    // host; see AGENTS.md.
    provider?: "openai-compatible" | "local";
    // Required for provider "openai-compatible" (any OpenAI-compatible
    // /v1/embeddings endpoint -- OpenAI, OpenRouter, Ollama, vLLM, LM
    // Studio, ...). Unused for "local".
    baseUrl?: string;
    // Plain string or a SecretRef object, same shape/resolution path as
    // index.ts's top-level apiToken -- see resolveApiKey below.
    apiKey?: unknown;
    model?: string;
    dimensions?: number;
  };
};

// Mirrors index.ts's resolveApiToken (same SecretRef-or-plain-string
// shape, same resolution libraries), but tolerant rather than throwing:
// apiToken is a required field with no sensible "unset" behavior, whereas
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
  // (disabled by config, embedding not fully configured, Node runtime
  // without node:sqlite, sqlite-vec failed to load, ...). `search` still
  // exists and is always safe to call -- it just always resolves to `[]`,
  // which is exactly the pre-existing stub behavior
  // trilium_search_notes already tolerates.
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

function defaultIndexPath(): string {
  return path.join(os.homedir(), ".openclaw", "plugins", "trilium", "semantic-index.db");
}

// Resolves the configured embedding provider, or undefined (with a warning
// already logged) if there isn't enough config to build one -- never
// throws, since a missing/incomplete embedding config is exactly the
// "stay lexical/attribute-only" case, not a plugin-registration failure.
async function resolveEmbeddingProvider(
  api: OpenClawPluginApi,
  raw: SemanticSearchPluginConfig["embedding"],
  logger: PluginLogger,
): Promise<EmbeddingProvider | undefined> {
  const provider = raw?.provider ?? "openai-compatible";

  if (provider === "local") {
    return createEmbeddingProvider({
      provider: "local",
      model: raw?.model,
      dimensions: raw?.dimensions,
    });
  }

  const apiKey = await resolveApiKey(api, raw?.apiKey);
  if (!apiKey || !raw?.baseUrl || !raw?.model || !raw?.dimensions) {
    logger.warn(
      "semantic search: embedding.baseUrl/apiKey/model/dimensions must all be configured for " +
        'the "openai-compatible" provider (or set embedding.provider to "local"), falling back ' +
        "to lexical/attribute-only search",
    );
    return undefined;
  }

  const config: EmbeddingProviderConfig = {
    provider: "openai-compatible",
    baseUrl: raw.baseUrl,
    apiKey,
    model: raw.model,
    dimensions: raw.dimensions,
  };
  return createEmbeddingProvider(config);
}

// Builds the semantic-search backend the same way index.ts builds the
// Trilium client handle: register() stays synchronous, this kicks off
// async setup without awaiting it, and hands back a promise every tool
// execute() can await once and reuse. `clientHandlePromise` is the same
// promise threaded into the note tools -- the source adapter awaits it
// internally rather than duplicating client construction.
export function createSemanticSearchHandle(
  api: OpenClawPluginApi,
  clientHandlePromise: Promise<TriliumClientHandle>,
): Promise<SemanticSearchHandle> {
  const rawConfig = (
    api.pluginConfig as { semanticSearch?: SemanticSearchPluginConfig } | undefined
  )?.semanticSearch;
  // Falls back to a no-op logger rather than assuming api.logger is always
  // set -- register() must never throw or produce an unhandled rejection
  // just because logging is unavailable in whatever hosted this plugin.
  const logger: PluginLogger = api.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  if (rawConfig?.enabled === false) {
    return Promise.resolve(unavailableHandle());
  }

  return setup(api, clientHandlePromise, rawConfig, logger).catch((err) => {
    logger.warn(
      `semantic search: setup failed, falling back to lexical/attribute-only search: ${describe(err)}`,
    );
    return unavailableHandle();
  });
}

async function setup(
  api: OpenClawPluginApi,
  clientHandlePromise: Promise<TriliumClientHandle>,
  rawConfig: SemanticSearchPluginConfig | undefined,
  logger: PluginLogger,
): Promise<SemanticSearchHandle> {
  const embeddingProvider = await resolveEmbeddingProvider(api, rawConfig?.embedding, logger);
  if (!embeddingProvider) return unavailableHandle();

  const result = await openSemanticIndex({
    embeddingProvider,
    dbPath: rawConfig?.indexPath ?? defaultIndexPath(),
    ...DEFAULT_SEMANTIC_INDEX_CONFIG,
  });
  if (!result.available) {
    logger.warn(
      `semantic search: index unavailable, falling back to lexical/attribute-only search: ${result.reason}`,
    );
    return unavailableHandle();
  }

  return setupWithOpenIndex(result.index, clientHandlePromise, api, logger);
}

function setupWithOpenIndex(
  index: SemanticIndex,
  clientHandlePromise: Promise<TriliumClientHandle>,
  api: OpenClawPluginApi,
  logger: PluginLogger,
): SemanticSearchHandle {
  const adapter = createTriliumSourceAdapter(clientHandlePromise.then((h) => h.client));

  let syncInFlight = false;
  const runSyncPass = async () => {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
      const summary = await index.sync(adapter, logger);
      logger.info?.(
        `semantic search: sync pass complete (processed=${summary.processed}, ` +
          `skipped=${summary.skippedUnchanged}, failed=${summary.failed})`,
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
  // lexical/attribute-only behavior this replaces.
  void runSyncPass();

  const interval = setInterval(() => void runSyncPass(), SYNC_INTERVAL_MS);
  interval.unref?.();

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    index.close();
  };

  api.lifecycle.registerRuntimeLifecycle({
    id: "trilium-semantic-search",
    description: "Closes the semantic search index on shutdown.",
    cleanup: () => dispose(),
  });

  return {
    available: true,
    // Trilium mixes plain fulltext tokens and structured `#label`/
    // `~relation`/`note.property` operators in the same `search` string --
    // extractFreeTextTerms pulls the free-text portion back out before
    // embedding anything (a pure structured-filter query has nothing to
    // embed, same no-op @mycelium/index's own searchSemantic already
    // applies to an empty term).
    search: async (rawSearch, limit) => {
      const searchTerm = rawSearch ? extractFreeTextTerms(rawSearch) : "";
      const matches = await index.search(searchTerm, limit, logger);
      return matches.map((match) => ({
        noteId: match.sourceId,
        snippet: match.snippet,
        score: match.score,
        startLine: match.startLine,
        endLine: match.endLine,
      }));
    },
    dispose,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
