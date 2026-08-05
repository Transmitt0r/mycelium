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

const tools = [...];

// stdio — for MCP clients that spawn a subprocess
await serveStdio(createMcpServer(tools, { name: "my-plugin", version: "1.0.0" }));

// or Streamable HTTP — for anything else. Streamable HTTP mounts one transport
// (and one Server) per session, so serveHttp takes a *factory* that returns a
// fresh Server for every new client session.
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
- `auth.basic` requires `Authorization: Basic <base64(username:password)>` (compared in constant time, after decoding).
- `host` controls the local interface the listener binds.
- `allowedHosts` sets an explicit `Host` allowlist (DNS-rebinding protection).
- `allowedOrigins` sets an explicit `Origin` allowlist for browser-based clients.
- `maxSessions` caps simultaneously-open sessions (default 100, rejected with 503 beyond that).
- `sessionIdleTimeoutMs` reaps sessions idle for that long (default 15 min; `0` disables; a session
  with a still-open stream is never reaped).
- `onServerError` is an optional observer for server errors after a successful bind.

Each MCP client session gets its own transport, and the `Mcp-Session-Id` header it echoes back is
the only link between that client's requests — treat it like a bearer token (store/forward it, and
don't log it), since anyone who holds a valid id can drive that session after passing the auth gate.

Requests that fail the check get `401` with a `WWW-Authenticate` challenge advertising only the
configured schemes (Bearer and/or Basic). The auth check runs before any path handling, so an
unauthenticated client can't probe which MCP paths exist. The returned handle exposes the bound
port and interface (`handle.port`, `handle.host`). Internal errors are never echoed back to
clients (a generic `500` body is returned instead).

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
