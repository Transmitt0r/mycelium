import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function serveStdio(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport());
}

export interface ServeHttpAuth {
  /** Require `Authorization: Bearer <token>` on every request. */
  bearerToken?: string;
  /** Require `Authorization: Basic base64(username:password)` on every request. */
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
   * DNS-rebinding protection: allowlist of accepted `Host` header values
   * (port-agnostic). When unset, only the default loopback-only server (no
   * `auth`, no explicit `host`) is restricted — to loopback hostnames. An
   * operator who opts into exposure controls the Host themselves, or sets this.
   */
  allowedHosts?: string[];
}

export interface HttpServerHandle {
  port: number;
  /** The interface the listener is bound to (e.g. "127.0.0.1"). */
  host: string;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

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
// Re-encoding and comparing normalises away padding variants so different
// encodings of the same value are accepted, while garbage is rejected.
function decodeBasic(credential: string): string | undefined {
  const normalized = credential.replace(/=+$/, "");
  let decoded: Buffer;
  try {
    decoded = Buffer.from(normalized, "base64");
  } catch {
    return undefined;
  }
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
  if (!auth) return;
  if (auth.bearerToken !== undefined) {
    if (typeof auth.bearerToken !== "string" || auth.bearerToken.length === 0) {
      throw new Error("serveHttp: auth.bearerToken must be a non-empty string when provided");
    }
  }
  if (auth.basic !== undefined) {
    if (
      typeof auth.basic.username !== "string" ||
      auth.basic.username.length === 0 ||
      typeof auth.basic.password !== "string" ||
      auth.basic.password.length === 0
    ) {
      throw new Error("serveHttp: auth.basic requires non-empty string username and password");
    }
  }
  if (!auth.bearerToken && !auth.basic) {
    throw new Error("serveHttp: auth requires at least one of bearerToken or basic");
  }
}

// Extract the hostname from a Host header, dropping the port. Handles both
// "host:port" and bracketed IPv6 like "[::1]:3000".
function hostName(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  let value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return undefined;
    return value.slice(1, end);
  }
  const colon = value.lastIndexOf(":");
  if (colon !== -1) value = value.slice(0, colon);
  return value;
}

function hostAllowed(options: ServeHttpOptions, hostHeader: string | undefined): boolean {
  const explicit = options.allowedHosts;
  const name = hostName(hostHeader);
  if (explicit && explicit.length > 0) {
    return name !== undefined && explicit.includes(name);
  }
  // Only the pure default (loopback binding, no explicit host, no auth) gets an
  // automatic loopback-Host restriction as DNS-rebinding protection. An operator
  // who opts into exposure (auth or explicit host) controls the Host themselves.
  if (options.host === undefined && options.auth === undefined) {
    return name !== undefined && LOOPBACK_HOSTS.includes(name);
  }
  return true;
}

export async function serveHttp(
  server: Server,
  options: ServeHttpOptions,
): Promise<HttpServerHandle> {
  const path = options.path ?? "/mcp";
  validateAuth(options.auth);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);

  // Fail-safe default: bind loopback only. MCP servers execute arbitrary
  // configured tools, so exposing one (e.g. behind a reverse proxy or on a LAN)
  // is an explicit choice via `host`, never an accidental default.
  const host = options.host ?? "127.0.0.1";

  const httpServer = createHttpServer((req, res) => {
    try {
      // Authorize before the path check so unauthenticated clients can't tell a
      // valid MCP path (401) from a bogus one (404) — no server-path enumeration.
      if (options.auth && !requestAuthorized(options.auth, req)) {
        res.writeHead(401, { "WWW-Authenticate": wwwAuthenticate(options.auth) }).end();
        return;
      }
      // DNS-rebinding protection on the default loopback server.
      if (!hostAllowed(options, req.headers.host)) {
        res.writeHead(400).end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      transport.handleRequest(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(err instanceof Error ? err.message : String(err));
      });
    } catch (err) {
      // Never let a malformed request crash the process.
      if (!res.headersSent) res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    }
  });

  // Surface bind failures (EADDRINUSE, EADDRNOTAVAIL) instead of hanging the
  // promise on an unhandled 'error' event, and clean up the connected transport
  // and socket so a retry starts from a clean state.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      httpServer.removeListener("error", onError);
      transport.close().catch(() => {});
      httpServer.close();
      reject(err);
    };
    httpServer.once("error", onError);
    httpServer.listen(options.port, host, () => {
      httpServer.removeListener("error", onError);
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
      await transport.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
