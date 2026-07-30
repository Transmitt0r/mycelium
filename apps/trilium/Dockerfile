# Standalone MCP server image for trilium (src/mcp-server.ts) -- no
# OpenClaw involved, see AGENTS.md and README's "Standalone MCP server"
# section. Build from the *monorepo root* (workspace:* deps need their
# @mycelium/* siblings, which only exist inside this repo):
#
#   docker build -f apps/trilium/Dockerfile -t trilium-mcp .
#
# Run (stdio, the default transport):
#
#   docker run -i --rm \
#     -e TRILIUM_BASE_URL=https://trilium.example.com \
#     -e TRILIUM_API_TOKEN=your-etapi-token \
#     trilium-mcp
#
# Or Streamable HTTP:
#
#   docker run --rm -p 3000:3000 -e MCP_TRANSPORT=http \
#     -e TRILIUM_BASE_URL=... -e TRILIUM_API_TOKEN=... \
#     trilium-mcp

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @transmitt0r/openclaw-plugin-trilium... run build
# `deploy` resolves workspace:* deps (@mycelium/embed, @mycelium/index,
# @mycelium/mcp) into a real, self-contained node_modules -- no symlinks
# back into /repo, so the runtime stage doesn't need the rest of the
# monorepo at all. --prod skips devDependencies (vitest, typescript, ...).
RUN pnpm --filter @transmitt0r/openclaw-plugin-trilium deploy --legacy --prod --child-concurrency=1 /app
# `openclaw` is only a peerDependency for the OpenClaw-plugin entrypoint
# (dist/index.js), which this image never runs -- but pnpm's peer-dependency
# auto-install still pulls it into the deploy regardless of
# peerDependenciesMeta's `optional: true`. It's also the single largest
# thing in the tree (100+MB). dist/mcp-server.js's module graph is verified
# to never import `openclaw` (see AGENTS.md), so pruning it here is safe.
RUN rm -rf /app/node_modules/openclaw /app/node_modules/.pnpm/openclaw@*

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app .
# The semantic index is the only state this server keeps -- give it a
# writable, volume-mountable home outside the container's own filesystem
# rather than defaulting under $HOME (which a non-root user may not own).
RUN mkdir -p /data && chown node:node /data
ENV TRILIUM_SEMANTIC_INDEX_PATH=/data/semantic-index.db
VOLUME ["/data"]
EXPOSE 3000
USER node
ENTRYPOINT ["node", "dist/mcp-server.js"]
