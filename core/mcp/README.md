# @transmitt0r/mycelium-mcp

Turns a set of agent-tool factories into a standalone MCP server — stdio and Streamable
HTTP both — without rewriting the tools themselves.

Tool definitions shaped `{ name, description, parameters: JSONSchema, execute() }` (true of
OpenClaw's `AnyAgentTool`, since TypeBox schemas already compile to plain JSON Schema) are
structurally close to MCP's `Tool` type already. This package is the thin, mechanical adapter
between the two — not a reimplementation of either.

## Usage

```ts
import { createMcpServer, serveStdio, serveHttp } from "@transmitt0r/mycelium-mcp";

const server = createMcpServer(myTools, { name: "my-plugin", version: "1.0.0" });

// stdio — for MCP clients that spawn a subprocess
await serveStdio(server);

// or Streamable HTTP — for anything else
const handle = await serveHttp(server, {
  port: 3000,
  // host: "127.0.0.1",              // bind a specific interface (default: loopback)
  // path: "/mcp",                   // request path (default: /mcp)
  // auth: { bearerToken: "secret" } // or { basic: { username, password } }
});
// handle.close() to shut down
```

`serveHttp` optionally enforces an `Authorization` check before handling any request:
- `auth.bearerToken` requires `Authorization: Bearer <token>` (compared in constant time).
- `auth.basic` requires `Authorization: Basic base64(username:password)` (compared in constant time, after decoding).
- `host` controls the local interface the listener binds.
- `allowedHosts` sets an explicit `Host` allowlist for DNS-rebinding protection.

Requests that fail the check get `401` with a `WWW-Authenticate` challenge advertising only the
configured schemes (Bearer and/or Basic). The auth check runs before any path handling, so an
unauthenticated client can't probe which MCP paths exist. The returned handle exposes the bound
port and interface (`handle.port`, `handle.host`).

Bind-address defaulting is fail-safe: every server binds **127.0.0.1 (loopback) only** unless you
pass an explicit `host`. MCP servers execute arbitrary configured tools, so exposing one is an
explicit choice — set `host` to the desired interface (e.g. `"0.0.0.0"`) when you intend to put
it behind a reverse proxy, and pair it with `auth` so the exposed endpoint isn't open. The default
loopback server additionally rejects non-loopback `Host` headers (DNS-rebinding protection); use
`allowedHosts` to permit specific hostnames.

`myTools` is an array of `BridgeableTool` — the same `{name, description, parameters, execute}`
shape OpenClaw's `AnyAgentTool` already has, passed in unmodified.

## Why this exists

Every plugin built on this shape (paperless-ngx, trilium, ...) can currently only run inside
OpenClaw's in-process plugin host. This package lets the exact same tool factories also run as
an ordinary MCP server, so anyone with an MCP-compatible client — not just OpenClaw users — can
use them.
