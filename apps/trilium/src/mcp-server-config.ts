import { readFileSync } from "node:fs";
import type { SemanticSearchPluginConfig } from "./semantic/handle.js";

export type StandaloneConfig = {
  baseUrl: string;
  apiToken: string;
  semanticSearch: SemanticSearchPluginConfig | undefined;
  readOnly: boolean;
};

export type TransportConfig =
  | { transport: "stdio" }
  | { transport: "http"; port: number; path?: string };

// Docker-secret convention: <NAME>_FILE points at a file (typically a
// bind-mounted secret) whose trimmed contents are the value -- trimming drops
// the trailing newline such files carry. Without it, the plain <NAME> env var
// is used exactly as before.
function readEnvOrFile(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const filePath = env[`${name}_FILE`];
  return filePath ? readFileSync(filePath, "utf8").trim() : env[name];
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = readEnvOrFile(env, name);
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

// No SecretRef concept exists outside OpenClaw's config system -- an env
// var is already either a plain string or unset, so embedding.apiKey is
// read the same way baseUrl/model/etc. are.
function readSemanticSearchConfig(env: NodeJS.ProcessEnv): SemanticSearchPluginConfig | undefined {
  if (env.TRILIUM_SEMANTIC_SEARCH_ENABLED === "false") {
    return { enabled: false };
  }

  const provider =
    env.TRILIUM_EMBEDDING_PROVIDER === "local" ||
    env.TRILIUM_EMBEDDING_PROVIDER === "openai-compatible"
      ? env.TRILIUM_EMBEDDING_PROVIDER
      : undefined;
  const hasEmbeddingConfig =
    provider !== undefined ||
    env.TRILIUM_EMBEDDING_BASE_URL !== undefined ||
    env.TRILIUM_EMBEDDING_API_KEY !== undefined ||
    env.TRILIUM_EMBEDDING_MODEL !== undefined ||
    env.TRILIUM_EMBEDDING_DIMENSIONS !== undefined;

  if (!hasEmbeddingConfig && env.TRILIUM_SEMANTIC_INDEX_PATH === undefined) {
    return undefined;
  }

  return {
    indexPath: env.TRILIUM_SEMANTIC_INDEX_PATH,
    embedding: hasEmbeddingConfig
      ? {
          provider,
          baseUrl: env.TRILIUM_EMBEDDING_BASE_URL,
          apiKey: env.TRILIUM_EMBEDDING_API_KEY,
          model: env.TRILIUM_EMBEDDING_MODEL,
          dimensions: env.TRILIUM_EMBEDDING_DIMENSIONS
            ? Number(env.TRILIUM_EMBEDDING_DIMENSIONS)
            : undefined,
        }
      : undefined,
  };
}

export function readStandaloneConfig(env: NodeJS.ProcessEnv): StandaloneConfig {
  return {
    baseUrl: requireEnv(env, "TRILIUM_BASE_URL").replace(/\/+$/, ""),
    apiToken: requireEnv(env, "TRILIUM_API_TOKEN"),
    semanticSearch: readSemanticSearchConfig(env),
    readOnly: readReadOnlyFlag(env, "TRILIUM_READ_ONLY"),
  };
}

// Read-only mode is armed only by the literal string "true". Unlike a
// truthy-string parse, an unrecognized *non-empty* value is a startup error
// rather than a silent read-write default. That direction matters for a
// security switch aimed at HTTP exposure: failing open on a typo'd value
// (TRILIUM_READ_ONLY=TRUE or =on) would quietly ship a fully-writable server
// to an exposed listener. Failing closed surfaces the misconfiguration at
// boot instead of at first compromise. Empty/unset reads as "off", which is
// the deliberate default (read-only is opt-in).
function readReadOnlyFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be exactly "true" or empty, got ${JSON.stringify(value)}`);
}

export function readTransportConfig(env: NodeJS.ProcessEnv): TransportConfig {
  if (env.MCP_TRANSPORT === "http") {
    return {
      transport: "http",
      port: env.MCP_PORT ? Number(env.MCP_PORT) : 3000,
      path: env.MCP_HTTP_PATH,
    };
  }
  return { transport: "stdio" };
}
