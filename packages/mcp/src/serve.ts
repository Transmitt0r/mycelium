import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function serveStdio(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport());
}

export interface ServeHttpOptions {
  port: number;
  path?: string;
}

export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
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
    transport.handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(options.port, resolve));
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
