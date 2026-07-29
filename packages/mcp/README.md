# @mycelium/mcp

Turns a set of agent-tool factories into a standalone MCP server — stdio and Streamable
HTTP both — without rewriting the tools themselves.

Tool definitions shaped `{ name, description, parameters: JSONSchema, execute() }` (true of
OpenClaw's `AnyAgentTool`, since TypeBox schemas already compile to plain JSON Schema) are
structurally close to MCP's `Tool` type already. This package is the thin, mechanical adapter
between the two — not a reimplementation of either.

## Usage

```ts
import { createMcpServer, serveStdio, serveHttp } from "@mycelium/mcp";

const server = createMcpServer(myTools, { name: "my-plugin", version: "1.0.0" });

// stdio — for MCP clients that spawn a subprocess
await serveStdio(server);

// or Streamable HTTP — for anything else
const handle = await serveHttp(server, { port: 3000 });
// handle.close() to shut down
```

`myTools` is an array of `BridgeableTool` — the same `{name, description, parameters, execute}`
shape OpenClaw's `AnyAgentTool` already has, passed in unmodified.

## Why this exists

Every plugin built on this shape (paperless-ngx, trilium, ...) can currently only run inside
OpenClaw's in-process plugin host. This package lets the exact same tool factories also run as
an ordinary MCP server, so anyone with an MCP-compatible client — not just OpenClaw users — can
use them.
