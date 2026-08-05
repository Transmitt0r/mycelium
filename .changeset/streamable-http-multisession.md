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
