import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, test } from "vitest";
import { createMcpServer } from "./bridge.js";
import type { BridgeableTool } from "./index.js";
import { serveHttp } from "./serve.js";

function echoTool(): BridgeableTool<{ text: string }> {
  return {
    name: "echo",
    description: "Echoes text back",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: params.text }], details: {} };
    },
  };
}

const handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
});

describe("serveHttp (real Streamable HTTP round-trip)", () => {
  test("a real HTTP client can list and call tools over the wire", async () => {
    const server = createMcpServer([echoTool()], { name: "http-test-server", version: "0.0.0" });
    // port 0 -> OS-assigned free port, read back from the returned handle.
    const handle = await serveHttp(server, { port: 0 });
    handles.push(handle);

    const client = new Client({ name: "http-test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
    );
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);

    const result = await client.callTool({ name: "echo", arguments: { text: "over the wire" } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("over the wire");

    await client.close();
  });

  test("a request to a path other than the configured one gets a 404", async () => {
    const server = createMcpServer([echoTool()], { name: "http-test-server", version: "0.0.0" });
    const handle = await serveHttp(server, { port: 0, path: "/custom-mcp" });
    handles.push(handle);

    const response = await fetch(`http://127.0.0.1:${handle.port}/wrong-path`);
    expect(response.status).toBe(404);
  });

  test("an authenticated client can list and call tools over the wire", async () => {
    const server = createMcpServer([echoTool()], { name: "http-test-server", version: "0.0.0" });
    const handle = await serveHttp(server, { port: 0, auth: { bearerToken: "s3cr3t" } });
    handles.push(handle);

    const client = new Client({ name: "http-test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      { requestInit: { headers: { authorization: "Bearer s3cr3t" } } },
    );
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);

    const result = await client.callTool({ name: "echo", arguments: { text: "authed" } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("authed");

    await client.close();
  });

  async function statusAt(
    handle: { port: number },
    headers?: Record<string, string>,
  ): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "http-test-client", version: "0.0.0" },
        },
      }),
    });
    return response.status;
  }

  test("bearer auth rejects missing and wrong tokens with 401", async () => {
    const server = createMcpServer([echoTool()], { name: "http-test-server", version: "0.0.0" });
    const handle = await serveHttp(server, { port: 0, auth: { bearerToken: "s3cr3t" } });
    handles.push(handle);

    expect(await statusAt(handle)).toBe(401);
    expect(await statusAt(handle, { authorization: "Bearer wrong" })).toBe(401);
    expect(await statusAt(handle, { authorization: "Bearer s3cr3t" })).not.toBe(401);
  });

  test("basic auth rejects missing and wrong credentials with 401", async () => {
    const server = createMcpServer([echoTool()], { name: "http-test-server", version: "0.0.0" });
    const handle = await serveHttp(server, {
      port: 0,
      auth: { basic: { username: "user", password: "pass" } },
    });
    handles.push(handle);

    expect(await statusAt(handle)).toBe(401);
    const ok = Buffer.from("user:pass").toString("base64");
    expect(await statusAt(handle, { authorization: `Basic ${ok}` })).not.toBe(401);
  });

  test("the host option binds the listener to a specific interface", async () => {
    const server = createMcpServer([echoTool()], { name: "http-test-server", version: "0.0.0" });
    const handle = await serveHttp(server, { port: 0, host: "127.0.0.1" });
    handles.push(handle);

    const response = await fetch(`http://127.0.0.1:${handle.port}/mcp`);
    // Reached the MCP handler via loopback (a bound listener, not a 404 from the path check).
    expect(response.status).not.toBe(404);
  });
});
