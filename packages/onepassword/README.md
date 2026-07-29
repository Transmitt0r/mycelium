# openclaw-plugin-onepassword

[![CI](https://github.com/Transmitt0r/openclaw-plugin-onepassword/actions/workflows/ci.yml/badge.svg)](https://github.com/Transmitt0r/openclaw-plugin-onepassword/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [OpenClaw](https://docs.openclaw.ai) plugin that provides a **1Password secret provider integration** — batch-resolution of secrets from your vaults via the `op` CLI.

Instead of defining a separate exec provider for every 1Password secret (6+ cold `op` starts at startup), this plugin registers one batched provider that resolves complete `op://` references. OpenClaw sends all ids in one stdin request, the resolver calls `op read` for each in sequence, and returns all resolved values in one stdout response.

## Install

```bash
openclaw plugins install clawhub:transmitt0r/openclaw-plugin-onepassword
```

Or for local development, point OpenClaw at a built copy of this repo.

### Prerequisites

- [1Password CLI](https://developer.1password.com/docs/cli/get-started) (`op`) installed on the gateway host
- Service account auth: `OP_SERVICE_ACCOUNT_TOKEN` set in the gateway environment
- Or desktop app integration: the 1Password desktop app running with CLI integration enabled

Verify with `op whoami` from the gateway host.

## Configure

1. Register the plugin and provider — no plugin config needed:

```json5
{
  plugins: {
    entries: {
      onepassword: { enabled: true },
    },
  },
  secrets: {
    providers: {
      onepassword: {
        source: "exec",
        pluginIntegration: {
          pluginId: "onepassword",
          integrationId: "secret-store",
        },
      },
    },
    defaults: {
      exec: "onepassword",
    },
  },
}
```

`secrets.defaults.exec: "onepassword"` makes `onepassword` the default provider for `source: "exec"` refs (see [SecretRef docs](https://docs.openclaw.ai/gateway/security) for how `source`/`provider`/`defaults` interact). To name it explicitly instead: `{ source: "exec", provider: "onepassword", id: "..." }`.

2. Replace your inline `op read` providers with SecretRefs whose `id` is a complete 1Password reference:

**Before (6 exec providers):**

```json5
{
  "op-openai": {
    source: "exec",
    command: "/home/openclaw/.local/bin/op-exec",
    args: ["read", "op://Openclaw/OpenAI API/credential"],
    passEnv: ["OP_SERVICE_ACCOUNT_TOKEN"],
    jsonOnly: false,
    timeoutMs: 5000,
  },
  // ... 5 more identical blocks
}
```

**After (one provider, clean refs):**

```json5
{
  models: {
    providers: {
      openai: {
        apiKey: { source: "exec", id: "op://Openclaw/a1b2c3d4e5f6g7h8i9j0k1l2m3/credential" },
      },
      google: {
        apiKey: { source: "exec", id: "op://Openclaw/n4o5p6q7r8s9t0u1v2w3x4y5z6/credential" },
      },
      // etc.
    },
  },
  channels: {
    telegram: {
      accounts: {
        default: {
          botToken: { source: "exec", id: "op://Openclaw/aabbccddeeffgghh11223344mm/credential" },
        },
      },
    },
  },
}
```

`id` must match OpenClaw's [SecretRef id pattern](https://docs.openclaw.ai/gateway/security) (letters, digits, `._:/#-`, no spaces). A plain `op://<vault name>/<item name>/<field>` reference usually violates that, since item (and sometimes vault) names contain spaces — so use 1Password's item ID instead of its display name for whichever segment needs it. Item IDs are plain alphanumeric strings, always valid. List them with:

```bash
op item list --vault Openclaw --format=json | jq -r '.[] | "\(.id)  \(.title)"'
```

There's no plugin-level config (no `vault`/`field`/`items` to set up): OpenClaw doesn't give a `secretProviderIntegration` process any channel to receive a plugin's own config (`plugins.entries.<id>.config`) at all — only static, manifest-authored `env`/`passEnv` reach it. Folding vault/item/field into the id itself sidesteps needing one.

## How it works

OpenClaw's exec provider protocol supports batching. The resolver:

1. Receives a JSON request on stdin with all requested `ids`
2. Passes each id straight to `op read --no-newline` (sequential — `op` has no batch-read)
3. Returns a JSON response on stdout with all resolved values

```json5
// stdin
{"protocolVersion":1,"provider":"onepassword","ids":["op://Openclaw/a1b2c3d4e5f6g7h8i9j0k1l2m3/credential"]}

// stdout
{"protocolVersion":1,"values":{"op://Openclaw/a1b2c3d4e5f6g7h8i9j0k1l2m3/credential":"sk-..."}}
```

Per-id errors (including an id that isn't a complete `op://` reference) are returned as `errors` entries without aborting the whole batch.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, commit conventions, and how releases work.