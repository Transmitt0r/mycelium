---
"@transmitt0r/mycelium-mcp": minor
---

Lift core/mcp onto the official high-level `McpServer` + stateless Streamable HTTP.

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
- The SDK dependency is pinned to `1.30.0` (the version whose
  `StreamableHTTPServerTransport` supports stateless mode via
  `sessionIdGenerator: undefined`).
