# @transmitt0r/mycelium-mcp

## 0.2.0

### Minor Changes

- 37de317: Lift core/mcp onto the official high-level `McpServer` + stateless Streamable HTTP.

  - `serveHttp` now serves **stateless** Streamable HTTP (the 2026-07-28 MCP spec
    revision) instead of the hand-wired per-session transport model. There is no
    protocol-level session anymore: every HTTP request is independent and gets a
    fresh `McpServer` + stateless transport from the SDK, so the session ceremony
    (transport map, `Mcp-Session-Id` routing/404s, `maxSessions` cap, idle reaper)
    is gone.
  - **Breaking (pre-1.0):** the `maxSessions` and `sessionIdleTimeoutMs` options are
    removed — they guarded per-session state that no longer exists.
  - `createMcpServer` returns the official high-level `McpServer`. Tools are still
    registered at the protocol layer (not `McpServer.registerTool`) so the arbitrary
    TypeBox JSON Schema in `BridgeableTool.parameters` — and tool annotations — pass
    through byte-for-byte unchanged; `registerTool` is Zod-only and would re-serialize
    the schema.
  - The lift relies on the SDK's stateless support, available since
    `@modelcontextprotocol/sdk` `^1.30.0` (the existing dependency — resolved to
    `1.30.0` in the lockfile, whose `StreamableHTTPServerTransport` supports
    stateless mode via `sessionIdGenerator: undefined`).

## 0.1.0

### Minor Changes

- 1392475: Add optional Bearer/Basic auth (Authorization check), always-on DNS-rebinding protection, and a configurable bind address to the Streamable HTTP transport.

  **Breaking (pre-1.0):** `serveHttp` now defaults to binding **127.0.0.1 (loopback)** instead of every interface. To reach a server from another host/container (e.g. behind a reverse proxy) you must pass an explicit `host` (e.g. `"0.0.0.0"`) **and** list the hostname(s) your clients/proxy will use in `allowedHosts` — DNS-rebinding protection is always on and only accepts loopback hostnames unless `allowedHosts` is set.

- 423c8c2: fix: serveHttp now serves one Streamable HTTP transport (and one Server) per session

  Previously `serveHttp` mounted a single StreamableHTTPServerTransport and routed every
  incoming request through it. The SDK's transport is single-session, so a second client's
  initialize was rejected with "Invalid Request: Server already initialized" — only one MCP
  client could ever connect, and reconnects failed too.

  `serveHttp` now accepts a server _factory_ (`() => Server`) instead of a single server
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
    _live_ sessions, and an operator exposing a `host` beyond loopback without auth should rely
    on OS/Node connection limits and reverse-proxy rate limiting for hard DoS defense, as this
    is connectionless HTTP's inherent limit.
  - All sessions share a single namespace and a session id is the only link between requests
    after auth; ids are randomUUIDs (not enumerable) and the optional HTTP auth gate still
    runs before any session handling, but with multiple users sharing credentials the session
    id is effectively the bearer of authenticity and should be treated as sensitive. Binding a
    session to a _specific_ credential isn't implemented because `serveHttp`'s auth is a single
    shared static credential (one Bearer token or one Basic user), i.e. every legitimate client
    presents the same `Authorization` header — there is no distinct identity to bind to, so the
    unguessable session id is the actual post-auth authority.

  > **Breaking change note:** the signature changes from `serveHttp(server, …)` to
  > `serveHttp(() => createMcpServer(...), …)` — a _factory_ that returns a fresh Server per
  > session (a Protocol can only own one transport, and a single reused instance would throw
  > on the second session). It is intentionally versioned as `minor` because
  > `@transmitt0r/mycelium-mcp` is unreleased (`0.0.0`) and monorepo-internal; both consumers
  > (apps/trilium, apps/paperless-ngx) are updated to the factory form in this same PR. Bump
  > to `major` before the first published release if this API ships unchanged.

- 1eeea4d: Add an optional `annotations` field to `BridgeableTool` (mirroring MCP's `ToolAnnotations`: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`) and pass it through to MCP's `tools/list` response, so clients can see read-only vs destructive tools machine-readably.
