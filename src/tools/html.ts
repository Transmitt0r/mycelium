// Shared helpers for Trilium's `text`-type note content, which Trilium's
// own CKEditor-based UI always stores as HTML -- unlike paperless-ngx's
// OCR content, which is already plain text. A tool-calling model reading
// raw `<p>`/`<ul>` markup wastes tokens on structural noise it doesn't
// need (see the "return only high-signal information" guidance this
// plugin otherwise follows), so reads convert to plain text by default;
// writes accept plain text and auto-wrap it, unless the caller opts into
// raw HTML either way.

// `String.slice` operates on UTF-16 code units, so a boundary computed by
// character count can land inside a surrogate pair (emoji, some CJK) and
// split it into two unpaired/replacement-rendering halves. Mirrors
// paperless-ngx's src/tools/documents.ts helpers of the same name.
export function backAwayFromLowSurrogate(str: string, index: number): number {
  const code = str.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}
export function forwardPastHighSurrogate(str: string, index: number): number {
  const code = str.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index + 1 : index;
}

export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

// Known HTML tag names Trilium's CKEditor realistically produces --
// deliberately a whitelist rather than "any <word...> shape", which
// previously false-positived on ordinary text containing a generic-type or
// comparison-like fragment (e.g. "Array<string>", "x<y>less than z"),
// causing formatContentForWrite to skip auto-wrapping and store that text
// raw/unescaped -- Trilium's editor then parses the false "tag" as literal,
// broken markup.
const KNOWN_HTML_TAGS =
  "p|div|span|br|hr|ul|ol|li|h[1-6]|a|strong|b|em|i|u|s|strike|table|thead|tbody|tfoot|tr|td|th|" +
  "blockquote|pre|code|img|figure|figcaption|sub|sup|mark|small|del|ins|dl|dt|dd|section|article";
const HTML_TAG_PATTERN = new RegExp(`<\\s*/?\\s*(?:${KNOWN_HTML_TAGS})(?:[\\s>/]|$)`, "i");

// Best-effort detector for "this note content is HTML" -- Trilium's own
// content endpoint has no separate flag for it (the response is always
// `text/html` per the ETAPI schema regardless of note type), so this
// sniffs for a known-tag opening/closing sequence rather than trusting the
// content-type header, which is the same for a `code` note's plain source
// as it is for a `text` note's markup.
export function looksLikeHtml(content: string): boolean {
  return HTML_TAG_PATTERN.test(content.slice(0, 500));
}

// Converts Trilium's CKEditor-authored HTML into readable plain text:
// paragraph-level closers (p/div/h1-6/blockquote/pre) become a blank line
// so distinct paragraphs stay visually separated (matching textToHtml's
// own paragraph model, which splits back apart on a blank line), while
// list items and table rows -- usually many adjacent lines, not separate
// paragraphs -- get a single line break instead. Not a general-purpose
// HTML-to-Markdown converter (no bold/italic/link preservation) -- the
// goal is a low-noise read, not a faithful re-render; use `raw_html: true`
// on the read tool for anything that needs the actual markup back.
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    // A nested <ul>/<ol> opening mid-item (e.g. <li>Parent<ul><li>Child)
    // otherwise has no break before it at all -- only the closing tags
    // below get one -- so the parent item's text and the nested list's
    // first bullet merge onto a single line.
    .replace(/<(ul|ol)[^>]*>/gi, "\n")
    // <td>/<th> boundaries are otherwise silently stripped with no
    // separator, so adjacent table cells (e.g. <td>Name</td><td>Age</td>)
    // concatenate into "NameAge" -- a tab keeps cells visually distinct
    // without claiming to be a real table renderer.
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<\/(li|tr)>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|blockquote|pre)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks)
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

// Converts plain text back into minimal HTML paragraphs so a model that
// writes plain text still gets sane rendering in Trilium's editor:
// blank-line-separated blocks become <p>...</p>, single newlines within a
// block become <br>. Only applied when the caller's input doesn't already
// look like HTML (see looksLikeHtml) -- passing through already-authored
// markup verbatim avoids double-escaping angle brackets a caller
// deliberately included.
export function textToHtml(text: string): string {
  // Without this, Windows-style \r\n input doesn't split into paragraphs
  // at all (the \n{2,} pattern below never matches a lone \n preceded by
  // \r), collapsing every intended paragraph into one <br>-joined block
  // with literal \r characters left in the stored HTML.
  const normalized = normalizeLineEndings(text);
  const escaped = normalized.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paragraphs = escaped.split(/\n{2,}/).map((block) => block.replace(/\n/g, "<br>"));
  return paragraphs.map((block) => `<p>${block}</p>`).join("");
}

// Shared by every content-write tool (notes, attachments): pass through
// verbatim if the caller already wrote HTML (or the note/attachment isn't
// a `text`-flavored one, e.g. `code` source), otherwise auto-wrap plain
// text into paragraphs so it renders reasonably instead of as one
// unbroken line.
export function formatContentForWrite(content: string, format: "auto" | "html"): string {
  if (format === "html") return content;
  return looksLikeHtml(content) ? content : textToHtml(content);
}

export type ContentStatus = "present" | "null" | "empty";

export function contentStatusFor(content: string): ContentStatus {
  return content === "" ? "empty" : "present";
}

export const MAX_RANGE_LINES = 500;
export const DEFAULT_RANGE_LINES = 200;

export type BoundedRead = {
  start_line: number;
  end_line: number;
  total_lines: number;
  content: string;
};

// Caps `content` to a requested (or default) line range, the same bound
// used across every bounded-read tool in this plugin -- mirrors
// paperless-ngx's src/tools/documents.ts capContentForResponse/read-range
// logic. `toolName` is shared by three different tools (note/attachment/
// revision content reads), so it's a param rather than hardcoded, letting
// each caller's thrown error stay attributable the same way every other
// hand-thrown Error in the tool files already is.
//
// This only bounds what's *returned* to the caller, not the work done to
// produce it: every caller already fetched the note/attachment/revision's
// *entire* content over HTTP (ETAPI's content endpoints have no Range-
// header/partial-fetch support to bound that part), and ran the full
// string through htmlToText's regex passes and this function's own
// content.split("\n") before this slice happens. Reading lines 1-10 of a
// very large note still pays that full cost -- accepted the same way
// paperless-ngx's sibling function accepts it, since neither API offers a
// cheaper alternative.
export function readRange(
  toolName: string,
  content: string,
  startLineParam: number | undefined,
  endLineParam: number | undefined,
): BoundedRead {
  const startLine = Math.max(1, startLineParam ?? 1);
  if (endLineParam !== undefined && endLineParam < startLine) {
    throw new Error(
      `${toolName}: end_line (${endLineParam}) is before start_line (${startLine}) -- pass an end_line greater than or equal to start_line.`,
    );
  }
  const lines = content.split("\n");
  const requestedEnd = endLineParam ?? startLine + DEFAULT_RANGE_LINES - 1;
  const endLine = Math.max(
    startLine,
    Math.min(requestedEnd, startLine + MAX_RANGE_LINES - 1, lines.length),
  );
  const isEmptyRange = startLine > lines.length;
  const slice = isEmptyRange ? [] : lines.slice(startLine - 1, endLine);
  return {
    start_line: startLine,
    end_line: isEmptyRange ? startLine - 1 : endLine,
    total_lines: lines.length,
    content: slice.join("\n"),
  };
}

const SNIPPET_CONTEXT_CHARS = 160;

// Best-effort preview around the first place `term` occurs in `content`.
// Mirrors paperless-ngx's extractSnippet, minus the Whoosh-syntax
// stripping (Trilium's own query language is stripped separately by
// src/semantic/query.ts before it ever reaches this function).
export function extractSnippet(content: string, term: string | undefined): string {
  const trimmed = content.trim();
  const leadingExcerpt = () => {
    if (trimmed.length <= SNIPPET_CONTEXT_CHARS * 2) return trimmed;
    const cut = forwardPastHighSurrogate(trimmed, SNIPPET_CONTEXT_CHARS * 2);
    return `${trimmed.slice(0, cut)}…`;
  };
  if (!term) return leadingExcerpt();

  const lowerContent = content.toLowerCase();
  const idx = lowerContent.indexOf(term.toLowerCase());
  if (idx === -1) return leadingExcerpt();

  const start = backAwayFromLowSurrogate(content, Math.max(0, idx - SNIPPET_CONTEXT_CHARS));
  const end = forwardPastHighSurrogate(
    content,
    Math.min(content.length, idx + term.length + SNIPPET_CONTEXT_CHARS),
  );
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}
