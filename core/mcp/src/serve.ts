import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function serveStdio(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport());
}

export interface ServeHttpAuth {
  /** Require `Authorization: Bearer <token>` on every request. */
  bearerToken?: string;
  /** Require `Authorization: Basic <base64("username:password")>` on every request. */
  basic?: { username: string; password: string };
}

export interface ServeHttpOptions {
  port: number;
  /** Local address/interface to bind. Defaults to the loopback interface. */
  host?: string;
  path?: string;
  /** When provided, requests must carry matching credentials (Bearer or Basic). */
  auth?: ServeHttpAuth;
  /**
   * Host-header allowlist (DNS-rebinding protection), compared case-insensitively
   * and port-agnostically. Always enforced; when unset only loopback hostnames are
   * accepted. An empty array rejects every Host. Exposing a server (proxy/LAN)
   * requires listing the hostname(s) clients will use.
   */
  allowedHosts?: string[];
  /**
   * Origin-header allowlist, compared case-insensitively. When set, requests that
   * carry an `Origin` header (i.e. browser-based clients) are rejected unless the
   * origin matches. Requests without an `Origin` (non-browser, e.g. via a reverse
   * proxy) are unaffected. An empty array rejects every browser request.
   */
  allowedOrigins?: string[];
  /** Optional handler for server errors after a successful bind (e.g. to log). */
  onServerError?: (err: Error) => void;
  /**
   * Upper bound on simultaneously-open sessions. New sessions beyond this cap
   * are rejected with 503 (Service Unavailable). Guards against unbounded
   * memory growth from a misbehaving client opening endless sessions.
   * Defaults to 100.
   */
  maxSessions?: number;
  /**
   * Idle timeout for established sessions, in milliseconds. A session that
   * receives no request for this long is closed and its slot released, so
   * abandoned clients can't accumulate and exhaust `maxSessions` forever
   * (Streamable HTTP sessions only end when the client sends DELETE or the
   * server reaps them — a bare client close sends no DELETE). Defaults to
   * 15 minutes; set `0` to disable idle reaping.
   */
  sessionIdleTimeoutMs?: number;
}

export interface HttpServerHandle {
  port: number;
  /** The interface the listener is bound to (e.g. "127.0.0.1"). */
  host: string;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

// Generic, secret-free body used for any internal error — never echo internal
// exception messages back to (possibly unauthenticated) clients.
const INTERNAL_ERROR = "Internal Server Error";

// Constant-time comparison for secrets. Both sides are hashed first so
// `timingSafeEqual` never sees a length mismatch (a length oracle on its own),
// and the comparison itself runs in constant time regardless of prefix.
function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function parseCredentials(header: string): { scheme: string; credential: string } | undefined {
  const space = header.indexOf(" ");
  if (space === -1) return undefined;
  return {
    scheme: header.slice(0, space).toLowerCase(),
    credential: header.slice(space + 1).trim(),
  };
}

// The canonical "username:password" only when Basic auth is fully configured
// (both fields non-empty). `undefined` otherwise, so a half-empty config can
// never act as a working Basic credential. validateAuth() rejects such configs
// at startup; this is defense-in-depth for the request path.
function basicCredentials(auth: ServeHttpAuth): string | undefined {
  if (!auth.basic || auth.basic.username.length === 0 || auth.basic.password.length === 0) {
    return undefined;
  }
  return `${auth.basic.username}:${auth.basic.password}`;
}

// Decode a Basic credential, returning undefined when it isn't valid base64.
// `Buffer.from(x, "base64")` ignores out-of-alphabet characters, so the decoded
// value is re-encoded and compared: any such tolerance changes the canonical
// encoding and marks the credential invalid.
function decodeBasic(credential: string): string | undefined {
  const normalized = credential.replace(/=+$/, "");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== normalized) {
    return undefined;
  }
  return decoded.toString("utf8");
}

function requestAuthorized(auth: ServeHttpAuth | undefined, req: IncomingMessage): boolean {
  if (!auth) return true;

  const header = req.headers.authorization;
  if (!header) return false;

  const parsed = parseCredentials(header);
  if (!parsed) return false;

  if (auth.bearerToken && parsed.scheme === "bearer") {
    return constantTimeEqual(parsed.credential, auth.bearerToken);
  }

  const expectedBasic = basicCredentials(auth);
  if (expectedBasic !== undefined && parsed.scheme === "basic") {
    const decoded = decodeBasic(parsed.credential);
    if (decoded !== undefined) {
      return constantTimeEqual(decoded, expectedBasic);
    }
  }

  return false;
}

// Advertise only the auth challenges that are actually configured, so clients
// aren't invited to send Basic credentials in clear text to a Bearer-only server
// (or vice versa).
function wwwAuthenticate(auth: ServeHttpAuth): string {
  const challenges: string[] = [];
  if (auth.bearerToken) challenges.push('Bearer realm="mcp"');
  if (auth.basic) challenges.push('Basic realm="mcp"');
  return challenges.join(", ");
}

// Fail fast on partial, empty, or mistyped auth config rather than letting it
// silently weaken the gate or crash the request handler later.
function validateAuth(auth: ServeHttpAuth | undefined): void {
  if (auth === undefined) return;
  if (auth === null || typeof auth !== "object") {
    throw new Error("serveHttp: auth must be an object when provided");
  }
  if (auth.bearerToken != null) {
    if (typeof auth.bearerToken !== "string" || auth.bearerToken.length === 0) {
      throw new Error("serveHttp: auth.bearerToken must be a non-empty string when provided");
    }
  }
  if (auth.basic != null) {
    if (
      typeof auth.basic?.username !== "string" ||
      auth.basic.username.length === 0 ||
      // RFC 7617: a username must not contain ":" (it would be
      // indistinguishable from the username/password separator).
      auth.basic.username.includes(":") ||
      typeof auth.basic.password !== "string" ||
      auth.basic.password.length === 0
    ) {
      throw new Error("serveHttp: auth.basic requires non-empty username (no ':') and password");
    }
  }
  if (!auth.bearerToken && !auth.basic) {
    throw new Error("serveHttp: auth requires at least one of bearerToken or basic");
  }
}

function validateHostLists(options: ServeHttpOptions): void {
  for (const field of ["allowedHosts", "allowedOrigins"] as const) {
    const list = options[field];
    if (list === undefined) continue;
    if (
      !Array.isArray(list) ||
      list.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      throw new Error(`serveHttp: ${field} must be an array of non-empty strings`);
    }
  }
}

// Extract the hostname from a Host header, dropping the port. Handles
// "host:port", bracketed IPv6 like "[::1]:3000", and bare IPv6 like "::1".
function hostName(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  let value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return undefined;
    return value.slice(1, end);
  }
  const colons = value.split(":").length - 1;
  if (colons > 1) {
    // Bare IPv6 (no port) — don't mistake the address colons for a port separator.
    return value;
  }
  const colon = value.lastIndexOf(":");
  if (colon !== -1) value = value.slice(0, colon);
  return value;
}

// DNS-rebinding / Host protection. Always enforced; `allowedHosts` is already
// normalized (lowercased) before reaching here, and `hostName` lowercases the
// incoming header, so matching is case-insensitive.
function hostAllowed(allowedHosts: string[] | undefined, hostHeader: string | undefined): boolean {
  const name = hostName(hostHeader);
  if (allowedHosts) {
    // An empty allowlist fails closed: no Host is accepted.
    if (allowedHosts.length === 0) return false;
    return name !== undefined && allowedHosts.includes(name);
  }
  return name !== undefined && LOOPBACK_HOSTS.includes(name);
}

// Origin protection for browser-based clients, opt-in via `allowedOrigins`.
// Requests without an Origin header (non-browser, e.g. via a reverse proxy) are
// unaffected; requests that do carry one are validated against the allowlist.
function originAllowed(
  allowedOrigins: string[] | undefined,
  originHeader: string | undefined,
): boolean {
  if (allowedOrigins === undefined) return true;
  if (!originHeader) return true;
  return allowedOrigins.includes(originHeader.toLowerCase());
}

// Streamable HTTP mounts one transport per session, and an @modelcontextprotocol
// Server instance can only own a single transport (Protocol.connect throws on a
// second connect). So serveHttp takes a *factory* rather than a server instance:
// each incoming session that initializes gets its own fresh Server + transport,
// keyed by the Mcp-Session-Id the client echoes back on subsequent requests.
export async function serveHttp(
  createServer: () => Server,
  options: ServeHttpOptions,
): Promise<HttpServerHandle> {
  const path = options.path ?? "/mcp";
  const maxSessions = options.maxSessions ?? 100;
  validateAuth(options.auth);
  validateHostLists(options);
  // Fail fast like the other options: a NaN/negative/fractional cap (e.g. from
  // `Number(process.env...)`) would silently disarm the DoS guard, so reject it
  // rather than let it weaken the limit at runtime.
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error("serveHttp: maxSessions must be a positive integer when provided");
  }
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 15 * 60_000;
  if (!Number.isInteger(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 0) {
    throw new Error("serveHttp: sessionIdleTimeoutMs must be a non-negative integer when provided");
  }
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Per-session last-activity stamp (epoch ms), refreshed on every request a
  // session receives and fed to the idle reaper so abandoned sessions — which
  // never send DELETE — are closed instead of pinning a session slot forever.
  const lastSeen = new Map<string, number>();
  // Number of currently-open responses per session (an SSE stream stays open
  // for the life of the session). A session with an open stream is alive even
  // if it hasn't sent a request recently, so the reaper must not harvest it.
  const openResponses = new Map<string, number>();
  // Set once handle.close() begins: reject requests that race the shutdown
  // (after transports.clear()) instead of reserving slots on a dying listener.
  let closing = false;
  // Synchronously-reserved session count. Unlike `transports.size` (which only
  // updates when an initialize completes, i.e. asynchronously), this is bumped
  // in the same tick a new-session request is accepted, so parallel initialize
  // requests can't all slip past the maxSessions check before any is counted.
  let sessions = 0;

  // Idle reaper: closes sessions that have gone silent, so abandoned clients
  // (which never send DELETE) can't pin a slot and exhaust `maxSessions` for
  // good. Sweeps at most once a minute (or the timeout, if it's shorter).
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  if (sessionIdleTimeoutMs > 0) {
    idleTimer = setInterval(sweepIdle, Math.min(sessionIdleTimeoutMs, 60_000));
    idleTimer.unref?.();
  }
  // Globally-idempotent slot release. onclose, the sweeper's failure path, and the
  // aborted-request backstop all funnel here, so a session's slot + map entries are
  // released exactly once no matter how many close() calls / teardown paths race it.
  const releasedTransports = new WeakSet<StreamableHTTPServerTransport>();
  function releaseSlot(transport: StreamableHTTPServerTransport, server?: Server): void {
    if (releasedTransports.has(transport)) return;
    releasedTransports.add(transport);
    sessions--;
    const id = transport.sessionId;
    if (id) {
      transports.delete(id);
      lastSeen.delete(id);
      openResponses.delete(id);
    }
    if (server) void server.close().catch(() => {});
  }

  // A session is only harvestable when it has neither recent activity nor any
  // still-open response stream (SSE). `?? 0` keeps an entry whose stamp is
  // somehow missing reapable rather than pinning its slot forever.
  function trackOpen(sessionId: string, res: ServerResponse): void {
    if (res.closed || res.destroyed) {
      // Response already gone (abort raced the registration) — the close handler
      // below would never fire, so don't leave a phantom open-stream count.
      return;
    }
    openResponses.set(sessionId, (openResponses.get(sessionId) ?? 0) + 1);
    res.once("close", () => {
      const n = openResponses.get(sessionId);
      if (n === undefined || n <= 1) openResponses.delete(sessionId);
      else openResponses.set(sessionId, n - 1);
    });
  }
  function sweepIdle(): void {
    const now = Date.now();
    for (const [id, transport] of transports) {
      const seen = lastSeen.get(id) ?? 0;
      const open = (openResponses.get(id) ?? 0) > 0;
      if (!open && now - seen > sessionIdleTimeoutMs) {
        void transport.close().then(
          () => {
            // On success the transport fires onclose, which runs releaseSlot.
          },
          (err) => {
            // close() rejected before firing onclose: hard-release so the session
            // can't leak and isn't re-reaped / re-routed every sweep.
            releaseSlot(transport);
            options.onServerError?.(err instanceof Error ? err : new Error(String(err)));
          },
        );
      }
    }
  }

  // Fail-safe default: bind loopback only. MCP servers execute arbitrary
  // configured tools, so exposing one (e.g. behind a reverse proxy or on a LAN)
  // is an explicit choice via `host`, never an accidental default.
  const host = options.host ?? "127.0.0.1";

  // Normalize allowlists to lowercase so matching is case-insensitive.
  const allowedHosts = options.allowedHosts?.map((h) => h.toLowerCase());
  const allowedOrigins = options.allowedOrigins?.map((o) => o.toLowerCase());

  const httpServer = createHttpServer(
    {
      // Bound the *request* phase so a client that never completes a body
      // (slow-loris) can't pin a reserved session slot indefinitely. On the
      // modern Node this repo targets (≥18.11), requestTimeout/headersTimeout
      // time receiving the REQUEST only and are cleared on response finish, so
      // a long-lived SSE response and a slow tool call are unaffected. The node
      // engines field is the source of truth for the minimum supported runtime.
      requestTimeout: 30_000,
      headersTimeout: 15_000,
    },
    (req, res) => {
      try {
        // Authorize before the path check so unauthenticated clients can't tell a
        // valid MCP path (401) from a bogus one (404) — no server-path enumeration.
        if (options.auth && !requestAuthorized(options.auth, req)) {
          res.writeHead(401, { "WWW-Authenticate": wwwAuthenticate(options.auth) }).end();
          return;
        }
        // DNS-rebinding protection + optional Origin validation.
        if (!hostAllowed(allowedHosts, req.headers.host)) {
          res.writeHead(400).end();
          return;
        }
        if (!originAllowed(allowedOrigins, req.headers.origin)) {
          res.writeHead(400).end();
          return;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== path) {
          res.writeHead(404).end();
          return;
        }
        if (closing) {
          // Shutdown is draining: don't accept work on a dying listener.
          res.writeHead(503).end();
          return;
        }

        const sessionId = req.headers["mcp-session-id"]?.toString();
        if (sessionId !== undefined && sessionId.length > 0) {
          // Client presented a session id — it must map to a live session.
          const existing = transports.get(sessionId);
          if (!existing) {
            // Unknown/expired session id: reject per spec, never spawn a new one.
            res.writeHead(404).end();
            return;
          }
          // Re-arm the idle clock for this session.
          lastSeen.set(sessionId, Date.now());
          // A GET/SSE stream stays open for the session's life; mark it so the
          // idle reaper doesn't harvest a live (but quiet) session.
          trackOpen(sessionId, res);
          existing.handleRequest(req, res).catch(respondWithError(res, options.onServerError));
          return;
        }

        // No session id → a fresh (initialize) session is being attempted. Reserve
        // a slot synchronously (same tick), so parallel initialize requests can't
        // all slip past the cap before any completion is counted. The reservation
        // is released via the transport's onclose once it exists; if construction
        // itself throws below, the catch releases it so no slot ever leaks.
        if (sessions >= maxSessions) {
          res.writeHead(503).end();
          return;
        }
        sessions++;

        // Let a fresh per-session transport decide: if this request is a valid
        // initialize it assigns the session id and registers itself. If it turns
        // out not to be (malformed JSON-RPC, stale id without a header, etc.) the
        // transport is never registered — tear it down so it can't leak.
        // `server` stays unassigned until the factory runs; releaseSlot reads it
        // as undefined then, which is handled (no TDZ).
        let server: Server | undefined;
        let transport: StreamableHTTPServerTransport;
        try {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              // Never register on a dying listener or a transport that was already
              // released (e.g. an abort race where the client dropped the request
              // mid-parse: onclose fired with sessionId still undefined). Registering
              // a dead transport would leak it in the maps — a later close() is a
              // releaseSlot no-op and the reaper's open-stream rule would pin it.
              if (closing || releasedTransports.has(transport)) {
                void transport.close().catch(() => {});
                return;
              }
              transports.set(id, transport);
              lastSeen.set(id, Date.now());
              // The (possibly SSE) initialize response stays open for the session's
              // life — count it so the reaper won't harvest a freshly-open session.
              trackOpen(id, res);
            },
          });
        } catch (err) {
          // Construction failed before any release path owned the reservation —
          // no transport exists to releaseSlot, so undo the reservation directly.
          sessions--;
          throw err;
        }
        // Releasing the reserved slot (and any registered session) is the transport's
        // onclose hook, which funnels into releaseSlot (globally idempotent) — DELETE
        // teardown, handle.close, the idle reaper and the abort backstop can never
        // double-release a slot.
        //
        // NOTE: this relies on Protocol.connect (SDK ≥1.30 chains it; verified) reading
        // the transport's existing onclose and chaining it rather than overwriting it.
        // If a future SDK stops chaining, sessions-- would never run and the cap would
        // silently stick at maxSessions — the DELETE-reconnect and idle-reap tests in
        // serve.test.ts guard specifically against that regression.
        transport.onclose = () => releaseSlot(transport, server);
        // Backstop for a slot that would otherwise never be freed: if the client
        // aborts before the request ever settles (so neither the leak-guard above
        // nor onclose runs) and no session was registered, release the reserved
        // slot on response close. Idempotent — releaseSlot makes double close a no-op.
        res.once("close", () => {
          if (transport.sessionId === undefined) {
            void transport.close().catch(() => {});
          }
        });
        try {
          server = createServer();
        } catch (err) {
          // A throwing factory must not leak the reserved slot or the transport.
          void transport.close().catch(() => {});
          throw err;
        }
        void server
          .connect(transport)
          .then(() => transport.handleRequest(req, res))
          .catch(respondWithError(res, options.onServerError))
          .finally(() => {
            // Leak guard: a request that never initialized a session was never
            // registered and only our close() will release its slot. Clean it up.
            if (transport.sessionId === undefined) {
              return transport.close().catch(() => {});
            }
          });
      } catch (err) {
        // Never let a malformed request crash the process, and never leak internals.
        if (!res.headersSent) res.writeHead(500);
        res.end(INTERNAL_ERROR);
        options.onServerError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
  );

  // Surface bind failures (EADDRINUSE, EADDRNOTAVAIL) instead of hanging the
  // promise on an unhandled 'error' event, and clean up connected transports
  // and sockets so a retry starts from a clean state.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      httpServer.removeListener("error", onError);
      if (idleTimer) clearInterval(idleTimer);
      // Best-effort cleanup: never throw from a failed bind, and disconnect any
      // transports so a retry on the same factory starts clean.
      Promise.allSettled([...transports.values()].map((t) => t.close())); // eslint-disable-line @typescript-eslint/no-floating-promises
      transports.clear();
      httpServer.close(() => {});
      reject(err);
    };
    httpServer.once("error", onError);
    httpServer.listen(options.port, host, () => {
      httpServer.removeListener("error", onError);
      // A runtime error after a successful bind must not crash the process;
      // route it to the optional observer instead of swallowing silently.
      httpServer.on("error", (err) => options.onServerError?.(err));
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = address && typeof address === "object" ? address.port : options.port;
  const boundHost = address && typeof address === "object" ? address.address : host;

  return {
    port: actualPort,
    host: boundHost,
    async close() {
      closing = true;
      if (idleTimer) clearInterval(idleTimer);
      await Promise.allSettled([...transports.values()].map((t) => t.close()));
      transports.clear();
      // httpServer.close() waits for all connections. Idle keep-alive sockets held
      // open by clients would otherwise block shutdown, so close idle ones first,
      // then force-close any stragglers (e.g. a slow-loris request mid-body) so the
      // shutdown promise can't wait out the full requestTimeout.
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
        httpServer.closeIdleConnections?.();
        httpServer.closeAllConnections?.();
      });
    },
  };
}

function respondWithError(res: ServerResponse, onServerError: ((err: Error) => void) | undefined) {
  return (err: unknown) => {
    try {
      if (!res.headersSent) {
        // Nothing sent yet: a clean 500 with the generic body.
        res.writeHead(500);
        res.end(INTERNAL_ERROR);
      } else if (!res.writableEnded) {
        // Headers already written (e.g. an in-flight SSE stream): don't inject a
        // raw text body into the stream, which would corrupt it — just close it.
        // The `writableEnded` guard also avoids ERR_STREAM_ALREADY_FINISHED.
        res.end();
      }
    } catch {
      // The response may already be destroyed (socket gone) — nothing to write.
    }
    onServerError?.(err instanceof Error ? err : new Error(String(err)));
  };
}
