---
"@transmitt0r/mycelium-mcp": minor
---

Add optional Bearer/Basic auth (Authorization check), DNS-rebinding protection, and a configurable bind address to the Streamable HTTP transport.

**Breaking (pre-1.0):** `serveHttp` now defaults to binding **127.0.0.1 (loopback)** instead of every interface. Previously a server bound all interfaces by default; now it requires an explicit `host` to be reachable from other hosts/containers (e.g. `host: "0.0.0.0"` behind a reverse proxy).
