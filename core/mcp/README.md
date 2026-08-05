# @transmitt0r/mycelium-mcp

Turns a set of agent-tool factories into a standalone MCP server — stdio and **stateless**
Streamable HTTP both — without rewriting the tools themselves.

Tool definitions shaped `{ name, description, parameters: JSONSchema, execute() }` (true of
OpenClaw's `AnyAgentTool`, since TypeBox schemas already compile to plain JSON Schema) are
structurally close to MCP's `Tool` type already. This package is the thin, mechanical adapter
between the two — not a reimplementation of either. It builds on the official
`@modelcontextprotocol/sdk`'s high-level `McpServer` and its stateless
`StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`), both available since
`@modelcontextprotocol/sdk` `^1.30.0`.

## Usage

```ts
import { createMcpServer, serveStdio, serveHttp } from "@transmitt0r/mycelium-mcp";

const tools = [...];

// stdio — for MCP clients that spawn a subprocess
await serveStdio(createMcpServer(tools, { name: "my-plugin", version: "1.0.0" }));

// or stateless Streamable HTTP — for anything else. Stateless streamable HTTP
// (2026-07-28 MCP spec revision) has NO protocol-level session: every request is
// independent and gets a fresh McpServer + transport. serveHttp therefore takes a
// *factory* that returns a fresh server for every request.
const handle = await serveHttp(
  () => createMcpServer(tools, { name: "my-plugin", version: "1.0.0" }),
  {
    port: 3000,
    // host: "127.0.0.1",              // bind a specific interface (default: loopback)
    // path: "/mcp",                   // request path (default: /mcp)
    // auth: { bearerToken: "secret" } // or { basic: { username, password } }
  },
);
// handle.close() to shut down
```

`serveHttp` optionally enforces an `Authorization` check before handling any request:
- `auth.bearerToken` requires `Authorization: Bearer <token>` (compared in constant time).
- `auth.basic` requires `Authorization: Basic <base64("user:pass")>` (compared in constant time, after decoding).
- `host` controls the local interface the listener binds.
- `allowedHosts` sets an explicit `Host` allowlist (DNS-rebinding protection).
- `allowedOrigins` sets an explicit `Origin` allowlist for browser-based clients.
- `onServerError` is an optional observer for server errors after a successful bind.

**Stateless model (2026-07-28 spec revision):** there is no `Mcp-Session-Id`, no session map,
and no per-session transport. The SDK's stateless `StreamableHTTPServerTransport`
(`sessionIdGenerator: undefined`) handles exactly one request per instance, so `serveHttp`
creates a fresh server + transport for every request and tears it down when the response
completes. This removes the hand-built session/DoS surface the previous per-session model
needed (no session-id 404s, no `maxSessions` cap, no idle reaper — those options were removed).
Slow-loris protection is handled by the node-level `requestTimeout`/`headersTimeout` on the
listener. Only `POST` is accepted in stateless mode (there is no session to `DELETE` and no
long-lived SSE stream to `GET`); other verbs get `405`.

`createMcpServer` returns the official high-level `McpServer`. Tools are registered at the
protocol layer rather than via `McpServer.registerTool` because `registerTool` is Zod-only and
re-serializes the schema — the arbitrary TypeBox JSON Schema in each tool's `parameters`, and
its `annotations`, pass through **byte-for-byte unchanged** here (the entire point of this
package).

Requests that fail the auth check get `401` with a `WWW-Authenticate` challenge advertising only
the configured schemes (Bearer and/or Basic). The auth check runs before any path handling, so an
unauthenticated client can't probe which MCP paths exist. Internal errors are never echoed back
to clients (a generic `500` body is returned instead).

Bind-address defaulting is fail-safe: every server binds **127.0.0.1 (loopback) only** unless you
pass an explicit `host`. MCP servers execute arbitrary configured tools, so exposing one is an
explicit choice — pair an explicit `host` (e.g. `"0.0.0.0"`) with `auth`, and list the hostname(s)
your clients/proxy will use in `allowedHosts`. Host-header validation is always on: without
`allowedHosts` only loopback `Host` headers are accepted (an empty `allowedHosts` accepts none),
so a server reached via a proxied/LAN hostname must declare that hostname explicitly. Origin
validation is opt-in via `allowedOrigins` (recommended for browser-facing deployments): when set,
requests carrying an `Origin` header must match, while non-browser requests without one are
unaffected.

`myTools` is an array of `BridgeableTool` — the same `{name, description, parameters, execute}`
shape OpenClaw's `AnyAgentTool` already has, passed in unmodified.

## Why this exists

Every plugin built on this shape (paperless-ngx, trilium, ...) can currently only run inside
OpenClaw's in-process plugin host. This package lets the exact same tool factories also run as
an ordinary MCP server, so anyone with an MCP-compatible client — not just OpenClaw users — can
use them.
