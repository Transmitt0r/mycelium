import createClient from "openapi-fetch";
import type { paths } from "./generated/paperless-schema.js";

export type PaperlessClientConfig = {
  baseUrl: string;
  apiToken: string;
};

export type PaperlessClient = ReturnType<typeof createClient<paths>>;

// Tools need baseUrl (not just the configured client) to build document
// links back to the paperless-ngx web UI in their responses.
export type PaperlessClientHandle = {
  client: PaperlessClient;
  baseUrl: string;
};

// paperless-ngx is typically a LAN device; without a bounded deadline, a
// stalled server or a dropped connection hangs a tool call indefinitely.
// Retries are deliberately not added here: PATCH/POST calls in this plugin
// aren't idempotent, so blindly retrying a timed-out write risks double-
// applying it -- better to surface a clear timeout error and let the caller
// decide whether to retry.
const DEFAULT_TIMEOUT_MS = 30_000;

export function createPaperlessClient(config: PaperlessClientConfig): PaperlessClient {
  return createClient<paths>({
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    headers: {
      Authorization: `Token ${config.apiToken}`,
    },
    // openapi-fetch defaults array query params to OpenAPI "form, exploded"
    // style (repeated ?fields=a&fields=b&fields=c). paperless-ngx's DRF
    // backend only reads the last occurrence of a repeated query key, so a
    // multi-value `fields` filter silently collapsed to just the last
    // field. paperless-ngx's own multi-value filters (fields, *__id__in,
    // etc.) all expect a single comma-joined value instead -- verified
    // against a live instance.
    querySerializer: { array: { style: "form", explode: false } },
    fetch: async (request) => {
      try {
        return await fetch(request, {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]),
        });
      } catch (err) {
        throw attributeNetworkError(err, request.url);
      }
    },
  });
}

// Node collapses every connection-level failure (DNS, refused, TLS, reset)
// into a bare `TypeError: fetch failed`, and openapi-fetch rethrows it
// untouched -- a message that names neither the host nor the endpoint. That
// matters most on the semantic sync path: @transmitt0r/mycelium-index catches
// per-item embedding failures inside its page loop, but a failure in the
// adapter's `listChanged` escapes the whole pass, so the host logs a naked
// "sync pass failed: fetch failed". With an embedding endpoint also in play
// that reads exactly like an embedding outage, and it has already been
// misread that way once -- while the AI SDK, by contrast, always wraps its
// own network errors ("Cannot connect to API: ..."), so a bare "fetch
// failed" can only ever have come from here.
//
// The actionable detail is already hanging off `err.cause` (e.g. "connect
// ECONNREFUSED 10.0.0.5:443"); this just lifts it into the message along
// with the endpoint that was being called. Purely diagnostic -- the error
// still propagates, nothing is swallowed or retried.
function attributeNetworkError(err: unknown, url: string): unknown {
  const endpoint = safeEndpoint(url);

  // AbortSignal.timeout's DOMException is equally anonymous ("The operation
  // was aborted due to timeout") -- name the endpoint and the deadline too.
  if (err instanceof Error && err.name === "TimeoutError") {
    return new Error(`paperless-ngx API timed out after ${DEFAULT_TIMEOUT_MS}ms (${endpoint})`, {
      cause: err,
    });
  }

  if (err instanceof TypeError && err.message === "fetch failed") {
    const detail = err.cause instanceof Error ? err.cause.message : String(err.cause ?? "unknown");
    return new Error(`paperless-ngx API unreachable (${endpoint}): ${detail}`, { cause: err });
  }

  // A caller-initiated abort, or anything else, is passed through untouched.
  return err;
}

// Origin + path only: the query string carries filter noise (and, on other
// endpoints, search terms) that has no place in a connectivity error.
function safeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * openapi-fetch returns { data, error, response } instead of throwing on
 * non-2xx responses. AgentTool.execute is expected to throw on failure, so
 * tools route their results through this instead of checking `error` by
 * hand.
 *
 * A non-2xx response with an empty body (a bare 401/403 from an auth proxy,
 * a 502/504 from a reverse proxy, an empty 429) leaves both `data` and
 * `error` undefined -- openapi-fetch never reads a body in that case. Status
 * is read from `response` so that failure still surfaces as a real HTTP
 * error instead of the generic "no data" message.
 */
export function unwrap<T>({
  data,
  error,
  response,
}: {
  data?: T;
  error?: unknown;
  response?: Response;
}): T {
  if (error !== undefined) {
    const detail = typeof error === "string" ? error : JSON.stringify(error);
    const status = response ? ` (${response.status} ${response.statusText})` : "";
    throw new Error(`paperless-ngx API error${status}: ${detail}`);
  }
  if (data === undefined) {
    if (response && !response.ok) {
      throw new Error(`paperless-ngx API error: ${response.status} ${response.statusText}`.trim());
    }
    throw new Error("paperless-ngx API returned no data");
  }
  return data;
}

/**
 * Shared response envelope for every tool's execute(): the `text` is what
 * the calling model reads, `details` carries the structured object for any
 * non-model consumer (logs, UI).
 */
export function toToolResult<T>(result: T): {
  content: [{ type: "text"; text: string }];
  details: T;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}
