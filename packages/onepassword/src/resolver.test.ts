import { describe, expect, it } from "vitest";

// The resolver is designed to be spawned as a child process by OpenClaw.
// We test the pure functions that don't touch stdin/stdout or spawn op.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function toOpRef(id: string): string | { error: string } {
  if (!id.startsWith("op://")) {
    return {
      error: `id must be a complete 1Password reference (op://vault/item/field), got "${id}"`,
    };
  }
  return id;
}

describe("toOpRef", () => {
  it("passes a complete op:// reference through unchanged", () => {
    expect(toOpRef("op://Openclaw/aabbccddeeffgghh11223344mm/credential")).toBe(
      "op://Openclaw/aabbccddeeffgghh11223344mm/credential",
    );
  });

  it("rejects an id that isn't a complete reference", () => {
    expect(toOpRef("brave-search")).toEqual({
      error:
        'id must be a complete 1Password reference (op://vault/item/field), got "brave-search"',
    });
  });
});

describe("manifest structure", () => {
  it("declares a secret-store integration", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, "..", "openclaw.plugin.json"), "utf8"),
    );
    expect(manifest.secretProviderIntegrations).toBeDefined();
    expect(manifest.secretProviderIntegrations["secret-store"]).toBeDefined();
    expect(manifest.secretProviderIntegrations["secret-store"].jsonOnly).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal `${node}` manifest value
    expect(manifest.secretProviderIntegrations["secret-store"].command).toBe("${node}");
  });
});

describe("package file list", () => {
  it("includes dist, skills, and manifest in the published tarball", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("skills");
    expect(pkg.files).toContain("openclaw.plugin.json");
  });

  it("lists openclaw-plugin as a keyword", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
    expect(pkg.keywords).toContain("openclaw-plugin");
    expect(pkg.keywords).toContain("1password");
  });
});
