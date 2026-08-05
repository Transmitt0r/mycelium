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
  and exhaust `maxSessions` forever. Explicit `DELETE` (the SDK's `transport.terminateSession()`)
  releases the slot immediately.
- Reaper scope: a session with a still-open SSE stream is treated as alive and is never
  harvested — the reaper reclaims sessions whose connection has actually gone away (stream
  closed), not ones a client is actively holding open. So `maxSessions` bounds the number of
  *live* sessions, and an operator exposing a `host` beyond loopback without auth should rely
  on OS/Node connection limits and reverse-proxy rate limiting for hard DoS defense, as this
  is connectionless HTTP's inherent limit.
- All sessions share a single namespace and a session id is the only link between requests
  after auth; ids are randomUUIDs (not enumerable) and the optional HTTP auth gate still
  runs before any session handling, but with multiple users sharing credentials the session
  id is effectively the bearer of authenticity and should be treated as sensitive.

> **Breaking change note:** the signature changes from `serveHttp(server, …)` to
> `serveHttp(() => createMcpServer(...), …)` — a *factory* that returns a fresh Server per
> session (a Protocol can only own one transport, and a single reused instance would throw
> on the second session). It is intentionally versioned as `minor` because
> `@transmitt0r/mycelium-mcp` is unreleased (`0.0.0`) and monorepo-internal; both consumers
> (apps/trilium, apps/paperless-ngx) are updated to the factory form in this same PR. Bump
> to `major` before the first published release if this API ships unchanged.
