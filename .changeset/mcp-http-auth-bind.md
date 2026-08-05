---
"@transmitt0r/mycelium-mcp": minor
---

Add optional Bearer/Basic auth (Authorization check), always-on DNS-rebinding protection, and a configurable bind address to the Streamable HTTP transport.

**Breaking (pre-1.0):** `serveHttp` now defaults to binding **127.0.0.1 (loopback)** instead of every interface. To reach a server from another host/container (e.g. behind a reverse proxy) you must pass an explicit `host` (e.g. `"0.0.0.0"`) **and** list the hostname(s) your clients/proxy will use in `allowedHosts` — DNS-rebinding protection is always on and only accepts loopback hostnames unless `allowedHosts` is set.
