# @transmitt0r/mycelium-openapi-codegen

Fetch an OpenAPI schema, run [openapi-typescript](https://openapi-ts.dev) against it, clean up
the temp file. You supply the fetch logic (auth headers, a pinned URL, whatever your source
needs); this owns the fetch-to-tempfile lifecycle and the codegen invocation.

## Usage

```ts
import { curlToFile, generateTypes } from "@transmitt0r/mycelium-openapi-codegen";

generateTypes({
  outPath: "src/generated/my-schema.d.ts",
  fetchSchema: (tmpDir) => curlToFile(tmpDir, "schema.json", ["-fsSL", "https://api.example.com/openapi.json"]),
});
```

`fetchSchema` receives a temp directory (cleaned up automatically after the run) and returns the
path to the fetched schema file. `curlToFile` covers the common case; anything more unusual
(auth headers, POST bodies) can shell out directly instead.

## Design notes

- Runs `openapi-typescript` via `pnpm dlx` in an isolated resolution, not as a local
  dependency — `openapi-typescript`'s codegen only supports TypeScript ^5.x, which would
  conflict with a caller building against a newer major.
- Fetches with `curl`, not `fetch()`: on macOS, Local Network access (TCC) is enforced
  per-binary, and bare `node`/`python3` get silently blocked hitting LAN IPs while `curl` is
  exempt.
