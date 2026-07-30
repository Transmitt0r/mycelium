export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (update: {
  content?: (TextContent | ImageContent)[];
  details?: Partial<TDetails>;
}) => void;

// Structural subset of OpenClaw's AnyAgentTool — no runtime dependency on
// openclaw itself. `parameters` is already JSON Schema (true of TypeBox
// output). execute()'s signature matches AnyAgentTool's exactly so real tool
// factories can be passed in unmodified.
export interface BridgeableTool<TParams = unknown, TDetails = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<{ content: (TextContent | ImageContent)[]; details: TDetails }>;
}

export { createMcpServer, type ServerInfo } from "./bridge.js";
export { type HttpServerHandle, type ServeHttpOptions, serveHttp, serveStdio } from "./serve.js";
