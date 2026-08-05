import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStandaloneConfig, readTransportConfig } from "./mcp-server-config.js";

describe("readStandaloneConfig", () => {
  it("throws a clear error when TRILIUM_BASE_URL is missing", () => {
    expect(() => readStandaloneConfig({ TRILIUM_API_TOKEN: "t" })).toThrow(
      "TRILIUM_BASE_URL environment variable is required",
    );
  });

  it("throws a clear error when TRILIUM_API_TOKEN is missing", () => {
    expect(() => readStandaloneConfig({ TRILIUM_BASE_URL: "https://trilium.example.com" })).toThrow(
      "TRILIUM_API_TOKEN environment variable is required",
    );
  });

  it("strips a trailing slash from baseUrl", () => {
    const config = readStandaloneConfig({
      TRILIUM_BASE_URL: "https://trilium.example.com/",
      TRILIUM_API_TOKEN: "t",
    });
    expect(config.baseUrl).toBe("https://trilium.example.com");
  });

  it("leaves semanticSearch undefined when no semantic env vars are set", () => {
    const config = readStandaloneConfig({
      TRILIUM_BASE_URL: "https://trilium.example.com",
      TRILIUM_API_TOKEN: "t",
    });
    expect(config.semanticSearch).toBeUndefined();
  });

  it("returns { enabled: false } when semantic search is explicitly disabled", () => {
    const config = readStandaloneConfig({
      TRILIUM_BASE_URL: "https://trilium.example.com",
      TRILIUM_API_TOKEN: "t",
      TRILIUM_SEMANTIC_SEARCH_ENABLED: "false",
    });
    expect(config.semanticSearch).toEqual({ enabled: false });
  });

  it("builds a full embedding config from TRILIUM_EMBEDDING_* vars, parsing dimensions as a number", () => {
    const config = readStandaloneConfig({
      TRILIUM_BASE_URL: "https://trilium.example.com",
      TRILIUM_API_TOKEN: "t",
      TRILIUM_EMBEDDING_BASE_URL: "https://openrouter.ai/api/v1",
      TRILIUM_EMBEDDING_API_KEY: "key",
      TRILIUM_EMBEDDING_MODEL: "text-embedding-3-small",
      TRILIUM_EMBEDDING_DIMENSIONS: "1536",
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
      TRILIUM_BASE_URL: "https://trilium.example.com",
      TRILIUM_API_TOKEN: "t",
      TRILIUM_EMBEDDING_PROVIDER: "local",
    });
    expect(config.semanticSearch?.embedding?.provider).toBe("local");
  });

  it("ignores an unrecognized TRILIUM_EMBEDDING_PROVIDER value", () => {
    const config = readStandaloneConfig({
      TRILIUM_BASE_URL: "https://trilium.example.com",
      TRILIUM_API_TOKEN: "t",
      TRILIUM_EMBEDDING_PROVIDER: "gemini",
    });
    expect(config.semanticSearch?.embedding?.provider).toBeUndefined();
  });

  it("carries indexPath through even with no embedding config set", () => {
    const config = readStandaloneConfig({
      TRILIUM_BASE_URL: "https://trilium.example.com",
      TRILIUM_API_TOKEN: "t",
      TRILIUM_SEMANTIC_INDEX_PATH: "/data/index.db",
    });
    expect(config.semanticSearch).toEqual({ indexPath: "/data/index.db", embedding: undefined });
  });

  describe("<VAR>_FILE Docker secrets", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "trilium-mcp-config-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const writeSecret = (name: string, contents: string): string => {
      const file = join(dir, name);
      writeFileSync(file, contents);
      return file;
    };

    it("reads apiToken from TRILIUM_API_TOKEN_FILE, trimming the trailing newline", () => {
      const config = readStandaloneConfig({
        TRILIUM_BASE_URL: "https://trilium.example.com",
        TRILIUM_API_TOKEN_FILE: writeSecret("api-token", "secret-etapi-token\n"),
      });
      expect(config.apiToken).toBe("secret-etapi-token");
    });

    it("still strips a trailing slash from a baseUrl read from TRILIUM_BASE_URL_FILE", () => {
      const config = readStandaloneConfig({
        TRILIUM_BASE_URL_FILE: writeSecret("base-url", "https://trilium.example.com/\n"),
        TRILIUM_API_TOKEN: "t",
      });
      expect(config.baseUrl).toBe("https://trilium.example.com");
    });

    it("prefers the _FILE variant when both it and the plain env var are set", () => {
      const config = readStandaloneConfig({
        TRILIUM_BASE_URL: "https://trilium.example.com",
        TRILIUM_API_TOKEN: "plain",
        TRILIUM_API_TOKEN_FILE: writeSecret("api-token", "from-file"),
      });
      expect(config.apiToken).toBe("from-file");
    });
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
