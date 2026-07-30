import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeableTool } from "./index.js";

export interface ServerInfo {
  name: string;
  version: string;
}

// Builds an MCP Server exposing `tools` unmodified — parameters (already
// JSON Schema, true of TypeBox output) map straight to inputSchema, and
// execute()'s {content, details} maps to CallToolResult.content.
// `details` is intentionally dropped rather than surfaced as
// structuredContent: MCP requires that to match a declared outputSchema,
// which BridgeableTool doesn't carry.
export function createMcpServer(tools: BridgeableTool[], serverInfo: ServerInfo): Server {
  const server = new Server(serverInfo, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as { type: "object"; [key: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.execute(randomUUID(), request.params.arguments ?? {});
      return { content: result.content };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  return server;
}
