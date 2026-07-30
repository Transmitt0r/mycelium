import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: "onepassword",
  name: "1Password",
  description:
    "1Password secret provider integration — resolves SecretRefs from your vaults via the op CLI.",
  register(_api) {
    // No tools, hooks, or runtime behavior needed here — the secret provider
    // integration is declared in openclaw.plugin.json and OpenClaw resolves
    // the exec command directly from the manifest.
  },
});

export default entry;
