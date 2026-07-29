# @mycelium/tooling-config

Shared biome + tsconfig presets: one source of truth for this monorepo and for the standalone
plugin repos (paperless-ngx, trilium, 1password, ...), instead of drifting hand-copied config.

## Usage

```jsonc
// biome.json
{ "extends": ["@mycelium/tooling-config/biome.preset.json"] }
```

```jsonc
// tsconfig.json
{
  "extends": "@mycelium/tooling-config/tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

Biome 2.5.x, ES2024/NodeNext, strict — the same baseline `openclaw-plugin-paperless-ngx` uses.
Within this monorepo, the root `biome.json`/`tsconfig.base.json` extend these presets directly
(by relative path, not the npm package, to avoid a self-dependency); external repos extend the
published `@mycelium/tooling-config` package the same way, as shown above.
