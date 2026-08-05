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
  | {
      transport: "http";
      port: number;
      path?: string;
      host: string;
      allowedHosts?: string[];
    };

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

// Parses a strict boolean env flag: only the literal strings "true" and
// "false" are accepted. An unset or empty variable yields undefined (empty
// strings are an everyday Docker/k8s artifact and must stay inert, not
// crash startup); any other non-empty value (e.g. "yes", "1", "TRUE") is a
// misconfiguration and throws rather than being silently coerced -- a
// typo'd flag must not quietly change behavior.
function parseBoolEnv(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false" (got "${raw}")`);
}

// Parses a strict positive-integer env value. Only decimal digits are
// accepted (Number("abc") would be NaN, "12.5" non-integer, "0x10"/"1e3"
// exotic radixes -- all rejected so a malformed dimensions value can never
// propagate NaN or a surprising number downstream). Unset/empty yields
// undefined.
function parsePositiveIntEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  const parsed = Number(raw);
  if (parsed <= 0 || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return parsed;
}

// Validates an MCP listen port: a decimal integer in the valid TCP range.
function parsePortEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between 1 and 65535 (got "${raw}")`);
  }
  const parsed = Number(raw);
  if (parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535 (got "${raw}")`);
  }
  return parsed;
}

// Validates an MCP bind host. Trims surrounding whitespace and rejects a value
// that itself contains whitespace -- a typo'd/concatenated value (" 0.0.0.0",
// "0.0.0.0 3000") would otherwise surface only later as an opaque listen()
// error instead of a clear startup failure. Empty/unset falls back to the
// loopback host. IPv6 literals (e.g. "::1") are allowed.
function parseBindHost(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim();
  if (/\s/.test(value)) {
    throw new Error(`${name} must be a host/IP without whitespace (got ${JSON.stringify(raw)})`);
  }
  return value;
}

// Parses a comma-separated Host allowlist (DNS-rebinding protection). Unset or
// whitespace-only yields undefined (loopback-only default); otherwise returns a
// trimmed, de-duplicated array of non-empty hostnames, or undefined when the
// value ends up empty after trimming.
function parseHostList(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const hosts = Array.from(
    new Set(
      raw
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h.length > 0),
    ),
  );
  return hosts.length > 0 ? hosts : undefined;
}

// Only the loopback interfaces are considered safe to bind unauthenticated
// (core/mcp's default Host allowlist uses the same set: 127.0.0.1, localhost,
// ::1). Anything else is a network exposure switch.
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// No SecretRef concept exists outside OpenClaw's config system -- an env
// var is already either a plain string or unset, so embedding.apiKey is
// read the same way baseUrl/model/etc. are.
function readSemanticSearchConfig(env: NodeJS.ProcessEnv): SemanticSearchPluginConfig | undefined {
  const enabled = parseBoolEnv(env, "PAPERLESS_SEMANTIC_SEARCH_ENABLED");
  if (enabled === false) {
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
          dimensions: parsePositiveIntEnv(env, "PAPERLESS_EMBEDDING_DIMENSIONS"),
        }
      : undefined,
  };
}

export function readStandaloneConfig(env: NodeJS.ProcessEnv): StandaloneConfig {
  return {
    baseUrl: requireEnv(env, "PAPERLESS_BASE_URL").replace(/\/+$/, ""),
    apiToken: requireEnv(env, "PAPERLESS_API_TOKEN"),
    semanticSearch: readSemanticSearchConfig(env),
    readOnly: readReadOnlyFlag(env, "PAPERLESS_READ_ONLY"),
  };
}

// Read-only mode is armed only by the literal string "true". Unlike a
// truthy-string parse, an unrecognized *non-empty* value is a startup error
// rather than a silent read-write default. That direction matters for a
// security switch aimed at HTTP exposure: failing open on a typo'd value
// (PAPERLESS_READ_ONLY=TRUE or =on) would quietly ship a fully-writable server
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
  const transport = env.MCP_TRANSPORT;
  if (transport === "http") {
    const host = parseBindHost(env, "MCP_BIND_HOST", "127.0.0.1");
    const allowedHosts = parseHostList(env, "MCP_ALLOWED_HOSTS");
    // Fail closed on non-loopback exposure: binding 0.0.0.0 without an
    // explicit host allowlist would ship an unauthenticated, network-reachable
    // server that the default loopback-only Host check can't protect (the Host
    // header is client-controlled, so a remote client just sends "localhost").
    // The app has no built-in auth, so a non-loopback bind is only sensible
    // behind an authenticated reverse proxy -- which always sends a real
    // hostname, so MCP_ALLOWED_HOSTS is never an unreasonable burden.
    if (!isLoopbackHost(host) && allowedHosts === undefined) {
      throw new Error(
        `MCP_BIND_HOST is bound to non-loopback interface "${host}" but MCP_ALLOWED_HOSTS is not set ` +
          "(the app has no built-in auth)",
      );
    }
    return {
      transport: "http",
      port: parsePortEnv(env, "MCP_PORT", 3000),
      path: env.MCP_HTTP_PATH,
      // Loopback-only by default. Exposing the server on all interfaces
      // (e.g. a bridged Docker network in front of a reverse proxy) is an
      // explicit opt-in via MCP_BIND_HOST -- an MCP server executes arbitrary
      // configured tools, so reaching it must never be an accident.
      host,
      // Reverse proxies (e.g. Caddy) send the public hostname in the Host
      // header, which core/mcp's DNS-rebinding protection rejects unless the
      // hostname is on the allowlist. Required for any non-loopback exposure.
      allowedHosts,
    };
  }
  // Fail closed on an unknown transport value instead of silently falling
  // back to stdio -- a typo'd MCP_TRANSPORT must error loudly, not quietly
  // switch the server's wire protocol. An unset or empty variable is the
  // everyday default and keeps the stdio fallback.
  if (transport !== undefined && transport !== "" && transport !== "stdio") {
    throw new Error(`Unknown MCP_TRANSPORT value "${transport}" (expected "stdio" or "http")`);
  }
  return { transport: "stdio" };
}
