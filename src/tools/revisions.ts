import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { TriliumClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";
import {
  contentStatusFor,
  htmlToText,
  looksLikeHtml,
  normalizeLineEndings,
  readRange,
} from "./html.js";

// Listing a note's revisions is trilium_get_note's include_revisions flag
// (GET /notes/{noteId}/revisions), not a tool here -- this file only
// covers creating a new snapshot and reading an existing one's content.

const createRevisionParams = Type.Object({
  note_id: Type.String({ description: "Note id to snapshot." }),
});

export function createCreateRevisionTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_create_revision",
    label: "Snapshot a Trilium note",
    description:
      "Create a revision (point-in-time snapshot) of a note's current title and content. Useful right " +
      "before a large rewrite via trilium_update_note, so the previous version stays recoverable. " +
      "List existing revisions via trilium_get_note's include_revisions, read one back with " +
      "trilium_read_revision_content.",
    parameters: createRevisionParams,
    execute: async (_toolCallId, params: Static<typeof createRevisionParams>) => {
      const { client } = await handlePromise;
      await client.POST("/notes/{noteId}/revision", {
        params: { path: { noteId: params.note_id } },
      });
      return toToolResult({ note_id: params.note_id, revision_created: true });
    },
  };
}

const readRevisionContentParams = Type.Object({
  revision_id: Type.String({
    description: "Revision id, from trilium_get_note's include_revisions.",
  }),
  start_line: Type.Optional(
    Type.Integer({ description: "1-indexed starting line (inclusive). Defaults to 1." }),
  ),
  end_line: Type.Optional(
    Type.Integer({ description: "Defaults to start_line + 199, capped at 500 lines per call." }),
  ),
  raw_html: Type.Optional(
    Type.Boolean({
      description: "Skip HTML-to-plain-text conversion for text-type revisions. Defaults to false.",
    }),
  ),
});

export function createReadRevisionContentTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_read_revision_content",
    label: "Read a Trilium revision's content",
    description:
      "Read a past revision's content, bounded to a line range -- same semantics as " +
      "trilium_read_note_content. Use this to see what a note used to say before comparing against " +
      "its current content.",
    parameters: readRevisionContentParams,
    execute: async (_toolCallId, params: Static<typeof readRevisionContentParams>) => {
      const { client } = await handlePromise;
      const rawContent = unwrap(
        await client.GET("/revisions/{revisionId}/content", {
          params: { path: { revisionId: params.revision_id } },
        }),
      );
      const wantsPlainText = !(params.raw_html ?? false) && looksLikeHtml(rawContent);
      const content = normalizeLineEndings(wantsPlainText ? htmlToText(rawContent) : rawContent);
      const range = readRange(content, params.start_line, params.end_line);
      return toToolResult({
        revision_id: params.revision_id,
        ...range,
        content_status: contentStatusFor(content),
      });
    },
  };
}
