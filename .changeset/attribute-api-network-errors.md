---
"@transmitt0r/openclaw-plugin-paperless-ngx": patch
"@transmitt0r/openclaw-plugin-trilium": patch
---

Name the endpoint and underlying cause in API connectivity errors

Node collapses every connection-level failure (DNS, refused, TLS, reset) into a
bare `TypeError: fetch failed`, and `openapi-fetch` rethrows it untouched. That
message names neither the host nor the endpoint.

It surfaced worst on the semantic sync path. `@transmitt0r/mycelium-index`
catches per-item embedding failures inside its page loop, but a failure in the
adapter's `listChanged` escapes the entire pass, so the host logged a naked
`semantic search: sync pass failed: fetch failed`. With an embedding endpoint
also in play, that reads exactly like an embedding outage — and was misdiagnosed
as one, even though the AI SDK always wraps its own network errors
(`Cannot connect to API: ...`), so a bare `fetch failed` could only ever have
come from the source API client.

Both clients now lift the detail already on `err.cause` into the message, along
with the endpoint being called:

```
semantic search: sync pass failed: paperless-ngx API unreachable
  (https://paperless.example.com/api/documents/): connect ECONNREFUSED 10.0.0.5:443
```

Request timeouts get the same treatment (`AbortSignal.timeout`'s
`"The operation was aborted due to timeout"` is equally anonymous). Purely
diagnostic: errors still propagate, nothing is swallowed or retried, and
caller-initiated aborts pass through untouched. Query strings are excluded from
the message so search terms don't leak into logs.
