---
"@transmitt0r/mycelium-mcp": minor
---

Add an optional `annotations` field to `BridgeableTool` (mirroring MCP's `ToolAnnotations`: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`) and pass it through to MCP's `tools/list` response, so clients can see read-only vs destructive tools machine-readably.
