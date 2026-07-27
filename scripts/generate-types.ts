/**
 * Regenerates src/generated/trilium-schema.d.ts from TriliumNext/Trilium's
 * bundled ETAPI OpenAPI spec, pinned to a specific release tag.
 *
 * Note the repo name: the project was TriliumNext/Notes until mid-2025,
 * which is now archived on GitHub -- active development continues at
 * TriliumNext/Trilium (also a rename from `triliumnext/notes` to
 * `triliumnext/trilium` on Docker Hub). Don't resurrect the old repo/image
 * names from an older version of this comment or from search results that
 * predate the rename.
 *
 * Unlike paperless-ngx, a running Trilium server doesn't serve its own
 * ETAPI OpenAPI document over HTTP (checked against a live instance: no
 * /etapi/openapi.yaml, no schema route) -- the spec only exists as a
 * static asset in the server source tree
 * (apps/server/src/assets/etapi.openapi.yaml, unchanged by the monorepo
 * restructure that moved most other server code under packages/). Fetching
 * it from GitHub at a pinned tag keeps the generated types matched to a
 * specific, known-good Trilium version instead of whatever the default
 * branch happens to contain.
 *
 * Usage: pnpm run generate:types -- v0.104.1
 * (defaults to the version below if no tag is given)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TAG = "v0.104.1";
const tag = process.argv[2] ?? DEFAULT_TAG;

const specUrl = `https://raw.githubusercontent.com/TriliumNext/Trilium/${tag}/apps/server/src/assets/etapi.openapi.yaml`;

const tmpDir = mkdtempSync(join(tmpdir(), "trilium-schema-"));
const specPath = join(tmpDir, "etapi.openapi.yaml");

// Fetched with `curl` rather than `fetch()` for the same reason as
// paperless-ngx's generate-types.ts: macOS's per-binary Local Network TCC
// entitlement silently blocks bare node/python3 hitting LAN IPs, though
// that doesn't apply here since this is a public GitHub URL -- kept
// consistent with the sibling plugin's script anyway since there's no
// downside to it.
const curlResult = spawnSync("curl", ["-fsSL", specUrl, "-o", specPath], { stdio: "inherit" });

if (curlResult.status !== 0) {
  rmSync(tmpDir, { recursive: true, force: true });
  console.error(`Failed to fetch ETAPI spec from ${specUrl}`);
  console.error("Check that the tag exists: https://github.com/TriliumNext/Notes/tags");
  process.exit(curlResult.status ?? 1);
}

const outPath = "src/generated/trilium-schema.d.ts";
// Same isolated-pnpm-dlx-resolution reasoning as paperless-ngx's script:
// openapi-typescript's codegen only supports typescript ^5.x, while this
// project builds against the latest TypeScript major.
const result = spawnSync("pnpm", ["dlx", "openapi-typescript", specPath, "-o", outPath], {
  stdio: "inherit",
});

rmSync(tmpDir, { recursive: true, force: true });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Wrote ${outPath} from ${tag}`);
