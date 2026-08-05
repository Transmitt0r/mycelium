import { randomUUID } from "node:crypto";
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
  /** Local address/interface to bind. Omit to bind all interfaces (Node default). */
  host?: string;
  path?: string;
  /** When provided, requests must carry matching credentials (Bearer or Basic). */
  auth?: ServeHttpAuth;
}

export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

function requestAuthorized(auth: ServeHttpAuth | undefined, req: IncomingMessage): boolean {
  if (!auth) return true;

  const header = req.headers.authorization;
  if (!header) return false;

  const space = header.indexOf(" ");
  const scheme = space === -1 ? "" : header.slice(0, space).toLowerCase();
  const credential = space === -1 ? "" : header.slice(space + 1).trim();

  if (auth.bearerToken && scheme === "bearer" && credential === auth.bearerToken) {
    return true;
  }

  if (auth.basic) {
    const expected = Buffer.from(`${auth.basic.username}:${auth.basic.password}`).toString(
      "base64",
    );
    if (scheme === "basic" && credential === expected) {
      return true;
    }
  }

  return false;
}

export async function serveHttp(
  server: Server,
  options: ServeHttpOptions,
): Promise<HttpServerHandle> {
  const path = options.path ?? "/mcp";
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);

  const httpServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    if (!requestAuthorized(options.auth, req)) {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="mcp", Basic realm="mcp"' }).end();
      return;
    }
    transport.handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(options.port, options.host, resolve));
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
