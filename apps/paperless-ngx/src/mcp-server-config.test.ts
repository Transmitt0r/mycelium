import { describe, expect, it } from "vitest";
import { readStandaloneConfig, readTransportConfig } from "./mcp-server-config.js";

describe("readStandaloneConfig", () => {
  it("throws a clear error when PAPERLESS_BASE_URL is missing", () => {
    expect(() => readStandaloneConfig({ PAPERLESS_API_TOKEN: "t" })).toThrow(
      "PAPERLESS_BASE_URL environment variable is required",
    );
  });

  it("throws a clear error when PAPERLESS_API_TOKEN is missing", () => {
    expect(() =>
      readStandaloneConfig({ PAPERLESS_BASE_URL: "https://paperless.example.com" }),
    ).toThrow("PAPERLESS_API_TOKEN environment variable is required");
  });

  it("strips a trailing slash from baseUrl", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com/",
      PAPERLESS_API_TOKEN: "t",
    });
    expect(config.baseUrl).toBe("https://paperless.example.com");
  });

  it("leaves semanticSearch undefined when no semantic env vars are set", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
    });
    expect(config.semanticSearch).toBeUndefined();
  });

  it("returns { enabled: false } when semantic search is explicitly disabled", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_SEMANTIC_SEARCH_ENABLED: "false",
    });
    expect(config.semanticSearch).toEqual({ enabled: false });
  });

  it("builds a full embedding config from PAPERLESS_EMBEDDING_* vars, parsing dimensions as a number", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_EMBEDDING_BASE_URL: "https://openrouter.ai/api/v1",
      PAPERLESS_EMBEDDING_API_KEY: "key",
      PAPERLESS_EMBEDDING_MODEL: "text-embedding-3-small",
      PAPERLESS_EMBEDDING_DIMENSIONS: "1536",
    });
    expect(config.semanticSearch).toEqual({
      indexPath: undefined,
      embedding: {
        provider: undefined,
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "key",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
    });
  });

  it("passes provider: local through only when explicitly set to a recognized value", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_EMBEDDING_PROVIDER: "local",
    });
    expect(config.semanticSearch?.embedding?.provider).toBe("local");
  });

  it("ignores an unrecognized PAPERLESS_EMBEDDING_PROVIDER value", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_EMBEDDING_PROVIDER: "gemini",
    });
    expect(config.semanticSearch?.embedding?.provider).toBeUndefined();
  });

  it("carries indexPath through even with no embedding config set", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_SEMANTIC_INDEX_PATH: "/data/index.db",
    });
    expect(config.semanticSearch).toEqual({ indexPath: "/data/index.db", embedding: undefined });
  });
});

describe("readTransportConfig", () => {
  it("defaults to stdio", () => {
    expect(readTransportConfig({})).toEqual({ transport: "stdio" });
  });

  it("defaults to stdio for any unrecognized MCP_TRANSPORT value", () => {
    expect(readTransportConfig({ MCP_TRANSPORT: "websocket" })).toEqual({ transport: "stdio" });
  });

  it("switches to http with a default port of 3000", () => {
    expect(readTransportConfig({ MCP_TRANSPORT: "http" })).toEqual({
      transport: "http",
      port: 3000,
      path: undefined,
    });
  });

  it("reads a custom port and path for http", () => {
    expect(
      readTransportConfig({ MCP_TRANSPORT: "http", MCP_PORT: "8080", MCP_HTTP_PATH: "/custom" }),
    ).toEqual({ transport: "http", port: 8080, path: "/custom" });
  });
});
