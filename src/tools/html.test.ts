import { describe, expect, it } from "vitest";
import {
  contentStatusFor,
  extractSnippet,
  formatContentForWrite,
  htmlToText,
  looksLikeHtml,
  readRange,
  textToHtml,
} from "./html.js";

describe("looksLikeHtml", () => {
  it("detects HTML-shaped content", () => {
    expect(looksLikeHtml("<p>Hello</p>")).toBe(true);
    expect(looksLikeHtml('<div class="x">Hello</div>')).toBe(true);
    expect(looksLikeHtml("plain text <br> more text")).toBe(true);
  });

  it("does not flag plain text or code as HTML", () => {
    expect(looksLikeHtml("just some plain text")).toBe(false);
    expect(looksLikeHtml("const x = 1 < 2;")).toBe(false);
  });

  // Regression test for a real bug found in review: the old heuristic
  // matched any "<word...>" shape, so ordinary text containing a
  // generic-type or comparison-like fragment was misdetected as HTML.
  it("does not false-positive on generic-type-like or comparison text", () => {
    expect(looksLikeHtml("a function returning Array<string> values")).toBe(false);
    expect(looksLikeHtml("if x<y> then something")).toBe(false);
  });
});

describe("htmlToText", () => {
  it("converts paragraphs and line breaks to newlines", () => {
    expect(htmlToText("<p>First</p><p>Second<br>third</p>")).toBe("First\n\nSecond\nthird");
  });

  it("converts list items to dashed lines", () => {
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  });

  it("strips script/style blocks entirely", () => {
    expect(htmlToText("<p>keep</p><script>evil()</script><style>.x{}</style>")).toBe("keep");
  });

  it("decodes common HTML entities", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &lt;3&gt;</p>")).toBe("Tom & Jerry <3>");
  });

  it("collapses excessive blank lines", () => {
    expect(htmlToText("<p>a</p><p></p><p></p><p></p><p>b</p>")).not.toMatch(/\n{3,}/);
  });

  // Regression test for a real bug found in review: adjacent table cells
  // had no separator at all and concatenated into one word.
  it("separates adjacent table cells instead of concatenating them", () => {
    expect(htmlToText("<table><tr><td>Name</td><td>Age</td></tr></table>")).toBe("Name\tAge");
  });

  // Regression test for a real bug found in review: a nested list opening
  // mid-item merged the parent item's text with the nested list's first
  // bullet onto one line.
  it("breaks before a nested list instead of merging it into the parent item's line", () => {
    const result = htmlToText("<ul><li>Parent<ul><li>Child</li></ul></li></ul>");
    expect(result).toBe("- Parent\n- Child");
  });
});

describe("textToHtml / formatContentForWrite", () => {
  it("wraps blank-line-separated blocks into paragraphs and single newlines into <br>", () => {
    expect(textToHtml("first line\nsecond line\n\nnew paragraph")).toBe(
      "<p>first line<br>second line</p><p>new paragraph</p>",
    );
  });

  it("escapes angle brackets in plain text before wrapping", () => {
    expect(textToHtml("a < b & c > d")).toBe("<p>a &lt; b &amp; c &gt; d</p>");
  });

  // Regression test for a real bug found in review: CRLF input never
  // normalized before splitting on \n{2,}, so Windows-style line endings
  // collapsed every paragraph into one <br>-joined block with literal \r
  // characters left in the stored HTML.
  it("normalizes CRLF before splitting into paragraphs", () => {
    expect(textToHtml("first line\r\nsecond line\r\n\r\nnew paragraph")).toBe(
      "<p>first line<br>second line</p><p>new paragraph</p>",
    );
  });

  it("formatContentForWrite passes through content that already looks like HTML", () => {
    const html = "<p>already html</p>";
    expect(formatContentForWrite(html, "auto")).toBe(html);
  });

  it("formatContentForWrite auto-wraps plain text", () => {
    expect(formatContentForWrite("hello", "auto")).toBe("<p>hello</p>");
  });

  it("formatContentForWrite passes through verbatim when format is html", () => {
    expect(formatContentForWrite("hello", "html")).toBe("hello");
  });
});

describe("contentStatusFor", () => {
  it("returns 'empty' for an empty string and 'present' otherwise", () => {
    expect(contentStatusFor("")).toBe("empty");
    expect(contentStatusFor("x")).toBe("present");
  });
});

describe("readRange", () => {
  const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");

  it("defaults to the first 200 lines from line 1", () => {
    const result = readRange("test_tool", content, undefined, undefined);
    expect(result).toEqual({ start_line: 1, end_line: 10, total_lines: 10, content });
  });

  it("respects an explicit start/end range", () => {
    const result = readRange("test_tool", content, 3, 5);
    expect(result).toEqual({
      start_line: 3,
      end_line: 5,
      total_lines: 10,
      content: "line3\nline4\nline5",
    });
  });

  it("caps the range at MAX_RANGE_LINES from start_line", () => {
    const long = Array.from({ length: 600 }, (_, i) => `l${i + 1}`).join("\n");
    const result = readRange("test_tool", long, 1, 599);
    expect(result.end_line).toBe(500);
  });

  it("throws when end_line is before start_line, prefixed with the caller's tool name", () => {
    expect(() => readRange("trilium_read_note_content", content, 5, 3)).toThrow(
      /^trilium_read_note_content: .*end_line/,
    );
  });

  it("returns an empty slice when start_line is past the end of the content", () => {
    const result = readRange("test_tool", content, 20, undefined);
    expect(result).toEqual({ start_line: 20, end_line: 19, total_lines: 10, content: "" });
  });
});

describe("extractSnippet", () => {
  it("returns a window of context around the matched term", () => {
    const content = `${"x".repeat(200)} findme ${"y".repeat(200)}`;
    const snippet = extractSnippet(content, "findme");
    expect(snippet).toContain("findme");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("falls back to a leading excerpt when the term isn't found", () => {
    expect(extractSnippet("short content", "nope")).toBe("short content");
  });

  it("returns the whole trimmed content when short and no term is given", () => {
    expect(extractSnippet("  short content  ", undefined)).toBe("short content");
  });
});
