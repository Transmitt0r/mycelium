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
  /** Local address/interface to bind. Defaults to loopback when no `auth` is set, otherwise all interfaces. */
  host?: string;
  path?: string;
  /** When provided, requests must carry matching credentials (Bearer or Basic). */
  auth?: ServeHttpAuth;
}

export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

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

function requestAuthorized(auth: ServeHttpAuth | undefined, req: IncomingMessage): boolean {
  if (!auth) return true;

  const header = req.headers.authorization;
  if (!header) return false;

  const parsed = parseCredentials(header);
  if (!parsed) return false;

  if (auth.bearerToken && parsed.scheme === "bearer") {
    return constantTimeEqual(parsed.credential, auth.bearerToken);
  }

  if (auth.basic && parsed.scheme === "basic") {
    const expected = Buffer.from(`${auth.basic.username}:${auth.basic.password}`).toString(
      "base64",
    );
    return constantTimeEqual(parsed.credential, expected);
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

function validateAuth(auth: ServeHttpAuth | undefined): void {
  if (!auth) return;
  const hasBearer = typeof auth.bearerToken === "string" && auth.bearerToken.length > 0;
  const hasBasic = !!auth.basic && auth.basic.username.length > 0 && auth.basic.password.length > 0;
  if (!hasBearer && !hasBasic) {
    throw new Error(
      "serveHttp: auth requires at least one of bearerToken or basic with non-empty credentials",
    );
  }
}

export async function serveHttp(
  server: Server,
  options: ServeHttpOptions,
): Promise<HttpServerHandle> {
  const path = options.path ?? "/mcp";
  validateAuth(options.auth);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);

  // An unauthenticated server must not silently listen on every interface: MCP
  // servers execute arbitrary configured tools. When no auth is configured,
  // default to the loopback interface unless an explicit host is given;
  // authenticated servers default to all interfaces so they can be exposed
  // behind a reverse proxy.
  const host = options.host ?? (options.auth ? undefined : "127.0.0.1");

  const httpServer = createHttpServer((req, res) => {
    // Authorize before the path check so unauthenticated clients can't tell a
    // valid MCP path (401) from a bogus one (404) — no server-path enumeration.
    if (options.auth && !requestAuthorized(options.auth, req)) {
      res.writeHead(401, { "WWW-Authenticate": wwwAuthenticate(options.auth) }).end();
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
  });

  await new Promise<void>((resolve) => httpServer.listen(options.port, host, resolve));
  const address = httpServer.address();
  const actualPort = address && typeof address === "object" ? address.port : options.port;

  return {
    port: actualPort,
    async close() {
      await transport.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
