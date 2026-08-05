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
  with 503 to bound memory growth from a misbehaving client. The cap (validated as a
  positive integer at startup) is enforced atomically against parallel `initialize` requests.
- An idle reaper (`sessionIdleTimeoutMs`, default 15 min, `0` disables) closes sessions that
  go silent, so a client that initializes and then disconnects without sending `DELETE` (a
  bare `client.close()` only aborts the local stream and sends no `DELETE`) can't pin a slot
  and exhaust `maxSessions` forever. A session with a still-open SSE stream is treated as
  alive and never harvested. Explicit `DELETE` (the SDK's `transport.terminateSession()`)
  releases the slot immediately.
- All sessions share a single namespace and a session id is the only link between requests
  after auth; ids are randomUUIDs (not enumerable) and the optional HTTP auth gate still
  runs before any session handling, but with multiple users sharing credentials the session
  id is effectively the bearer of authenticity and should be treated as sensitive.
