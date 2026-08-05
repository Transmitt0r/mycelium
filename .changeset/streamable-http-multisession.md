---
"@transmitt0r/mycelium-mcp": minor
---

fix: serveHttp now serves one Streamable HTTP transport (and one Server) per session

Previously `serveHttp` mounted a single StreamableHTTPServerTransport and routed every
incoming request through it. The SDK's transport is single-session, so a second client's
initialize was rejected with "Invalid Request: Server already initialized" — only one MCP
client could ever connect, and reconnects failed too.

`serveHttp` now accepts a server *factory* (`() => Server`) instead of a single server
instance, and creates a fresh transport + Server per session, keyed by the Mcp-Session-Id
header. Multiple clients can connect and use tools simultaneously, and a new session can be
established after a previous one closes.

Hardening (from skeptical review):

- An unknown/expired `Mcp-Session-Id` now gets a spec-conformant **404**, rather than being
  silently treated as a brand-new session.
- A request that never actually initializes a session (malformed JSON-RPC, or a fresh
  transport that fails to register) has its transport + Server torn down, so no instance
  leaks per failed request.
- A `maxSessions` option (default 100) caps simultaneous sessions, rejecting further ones
  with 503 to bound memory growth from a misbehaving client.
