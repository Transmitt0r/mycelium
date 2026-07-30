import type { SemanticSearchPluginConfig } from "./semantic/handle.js";

export type StandaloneConfig = {
  baseUrl: string;
  apiToken: string;
  semanticSearch: SemanticSearchPluginConfig | undefined;
};

export type TransportConfig =
  | { transport: "stdio" }
  | { transport: "http"; port: number; path?: string };

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

// No SecretRef concept exists outside OpenClaw's config system -- an env
// var is already either a plain string or unset, so embedding.apiKey is
// read the same way baseUrl/model/etc. are.
function readSemanticSearchConfig(env: NodeJS.ProcessEnv): SemanticSearchPluginConfig | undefined {
  if (env.PAPERLESS_SEMANTIC_SEARCH_ENABLED === "false") {
    return { enabled: false };
  }

  const provider =
    env.PAPERLESS_EMBEDDING_PROVIDER === "local" ||
    env.PAPERLESS_EMBEDDING_PROVIDER === "openai-compatible"
      ? env.PAPERLESS_EMBEDDING_PROVIDER
      : undefined;
  const hasEmbeddingConfig =
    provider !== undefined ||
    env.PAPERLESS_EMBEDDING_BASE_URL !== undefined ||
    env.PAPERLESS_EMBEDDING_API_KEY !== undefined ||
    env.PAPERLESS_EMBEDDING_MODEL !== undefined ||
    env.PAPERLESS_EMBEDDING_DIMENSIONS !== undefined;

  if (!hasEmbeddingConfig && env.PAPERLESS_SEMANTIC_INDEX_PATH === undefined) {
    return undefined;
  }

  return {
    indexPath: env.PAPERLESS_SEMANTIC_INDEX_PATH,
    embedding: hasEmbeddingConfig
      ? {
          provider,
          baseUrl: env.PAPERLESS_EMBEDDING_BASE_URL,
          apiKey: env.PAPERLESS_EMBEDDING_API_KEY,
          model: env.PAPERLESS_EMBEDDING_MODEL,
          dimensions: env.PAPERLESS_EMBEDDING_DIMENSIONS
            ? Number(env.PAPERLESS_EMBEDDING_DIMENSIONS)
            : undefined,
        }
      : undefined,
  };
}

export function readStandaloneConfig(env: NodeJS.ProcessEnv): StandaloneConfig {
  return {
    baseUrl: requireEnv(env, "PAPERLESS_BASE_URL").replace(/\/+$/, ""),
    apiToken: requireEnv(env, "PAPERLESS_API_TOKEN"),
    semanticSearch: readSemanticSearchConfig(env),
  };
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
