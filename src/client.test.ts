import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriliumClient, unwrap } from "./client.js";

describe("unwrap", () => {
  it("returns data on success", () => {
    expect(unwrap({ data: { noteId: "abc1" } })).toEqual({ noteId: "abc1" });
  });

  it("throws with the ETAPI error code and message", () => {
    expect(() =>
      unwrap({
        error: { status: 400, code: "NOTE_IS_PROTECTED", message: "Note 'x' is protected" },
      }),
    ).toThrow(/NOTE_IS_PROTECTED: Note 'x' is protected/);
  });

  it("falls back to stringifying an error without a code/message shape", () => {
    expect(() => unwrap({ error: "plain string error" })).toThrow(/plain string error/);
  });

  it("throws when data is missing", () => {
    expect(() => unwrap({})).toThrow(/no data/);
  });

  it("surfaces the HTTP status for a non-2xx response with an empty body", () => {
    const response = new Response(null, { status: 401, statusText: "Unauthorized" });
    expect(() => unwrap({ response })).toThrow(/401/);
  });
});

describe("createTriliumClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the token as an unprefixed Authorization header, appends /etapi, and strips trailing slashes", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createTriliumClient({
      baseUrl: "https://trilium.example.com/",
      apiToken: "test-token",
    });
    await client.GET("/notes", { params: { query: { search: "test" } } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://trilium.example.com/etapi/notes?search=test");
    expect(request.headers.get("authorization")).toBe("test-token");
  });
});
