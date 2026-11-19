# syntax=docker/dockerfile:1
# Image for the quoter-bot bot. The build context MUST be the repository root so workspace
# packages resolve. Bun installs and runs the build scripts, esbuild bundles, node runs; the final stage has no Bun.
#
# Two stages so the shipped image carries only this bot: `build` installs the workspace and bundles
# the bot; the runtime stage starts from a fresh base and receives nothing but the bot's
# self-contained bundle. The image publishes publicly on release (morphoorg/quoter), so no other
# bot's code, no workspace source, and no package manager may ship in the final stage.
FROM node:24.22.3-slim AS build
ENV HOME=/home/node

# Bun is the package manager of the build stage only, copied from its pinned official image.
COPY --from=oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 /usr/local/bin/bun /usr/local/bin/bun
RUN /usr/bin/mkdir -p /repo && /usr/bin/chown node:node /repo

# Install dependencies and run workspace build scripts without root privileges. The official image
# owns /home/node, so Bun can write its user-level install cache under HOME.
USER node
WORKDIR /repo

# Manifests first, so the install layer is cached. package.json holds the workspaces, catalog,
# overrides, patchedDependencies and trustedDependencies; bunfig.toml the install settings.
COPY --chown=node:node package.json bunfig.toml bun.lock ./
# `package.json` declares patchedDependencies, so the install fails without these.
COPY --chown=node:node patches ./patches

# All workspace manifests and sources are needed to resolve links and build the bot bundle.
COPY --chown=node:node packages ./packages
COPY --chown=node:node framework ./framework
COPY --chown=node:node bots ./bots
RUN bun install --frozen-lockfile
# The bundle stamps the build the journal names; pass `--build-arg BUILD_REVISION=$(git rev-parse HEAD)`.
ARG BUILD_REVISION
ARG BUILD_IMAGE_TAG
ENV BUILD_REVISION=$BUILD_REVISION BUILD_IMAGE_TAG=$BUILD_IMAGE_TAG
# Bun orders a filtered run by direct dependencies only, so @repo/contracts, which several bots
# reach only transitively, builds first.
RUN bun run --filter @repo/contracts build && bun run --filter @morpho-org/quoter build

# Runtime stage. dist/src/index.js is a self-contained esbuild bundle (scripts/build.ts,
# bundle: true), so no node_modules ships; the bot's package.json rides along only so node treats
# the bundle's .js as ESM ("type": "module"). Files stay root-owned and read-only to the runtime
# user.
FROM node:24.22.3-slim
ENV HOME=/home/node
ENV XDG_STATE_HOME=/state

RUN /usr/bin/mkdir -p /state && /usr/bin/chown node:node /state

# The Helm chart and deploy/quoter values exec and mount under /repo/bots/quoter-bot.
COPY --from=build --chown=0:0 --chmod=0555 /repo/bots/quoter/package.json /repo/bots/quoter-bot/package.json
COPY --from=build --chown=0:0 --chmod=0555 /repo/bots/quoter/dist /repo/bots/quoter-bot/dist

WORKDIR /repo/bots/quoter-bot
USER node
CMD ["node", "dist/src/index.js", "start", "--verbose"]
