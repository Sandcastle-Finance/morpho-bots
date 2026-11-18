# syntax=docker/dockerfile:1
# Image for the blue-liquidation bot. The build context MUST be the repo root so the workspace packages
# (packages/*) resolve — docker-compose.yml sets `context: ../..` and CI builds from the repo root.
# Borrower discovery polls the Morpho API, so there is no indexer/database sidecar to build.
# Bun installs and runs the build scripts, esbuild bundles, node runs; the final stage has no Bun.
FROM node:24.22.3-slim AS build

# Bun is the package manager of the build stage only, copied from its pinned official image.
COPY --from=oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 /usr/local/bin/bun /usr/local/bin/bun
RUN mkdir -p /repo && chown node:node /repo
WORKDIR /repo
USER node

# Manifests first, so the install layer is cached. package.json holds the workspaces, catalog,
# overrides, patchedDependencies and trustedDependencies; bunfig.toml the install settings.
COPY --chown=node:node package.json bunfig.toml bun.lock ./
# `package.json` declares patchedDependencies, so the install fails without these.
COPY --chown=node:node patches ./patches

# All members' package.json are needed for Bun to resolve the `workspace:*` links.
COPY --chown=node:node packages ./packages
COPY --chown=node:node framework ./framework
COPY --chown=node:node bots ./bots
RUN bun install --frozen-lockfile

# Bundle at image-build time: workspace dists plus this bot's esbuild bundle (soltag `sol``` templates
# compiled in where present), so the container starts a plain `node` with no runtime transform.
# Bun orders a filtered run by direct dependencies only, so @repo/contracts, which several bots
# reach only transitively, builds first.
RUN bun run --filter @repo/contracts build && bun run --filter './bots/*' --if-present build

# Only the built workspace crosses over, so the image runs Node with no package manager in it.
FROM node:24.22.3-slim
RUN mkdir -p /repo && chown node:node /repo
WORKDIR /repo
USER node
COPY --from=build --chown=node:node /repo /repo

# The kernel's ledger and the journal live here, on a volume in production. Owned by `node`, so a
# fresh Compose named volume starts writable.
RUN mkdir -p /repo/state

# The journal names the build that wrote it; pass `--build-arg BUILD_REVISION=$(git rev-parse HEAD)`.
ARG BUILD_REVISION
ARG BUILD_IMAGE_TAG=blue-liquidation
ENV BUILD_REVISION=$BUILD_REVISION BUILD_IMAGE_TAG=$BUILD_IMAGE_TAG

WORKDIR /repo/bots/blue-liquidation
CMD ["node", "dist/src/index.js"]
