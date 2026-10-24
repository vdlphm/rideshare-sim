# syntax=docker/dockerfile:1
# One reusable image recipe for every Node service: docker build --build-arg APP=<name> .
# Stages: build (full workspace, compile) -> prod (production deps + built output only) -> runtime.
ARG NODE_VERSION=22.23.4

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
# Manifests first so the dependency layer is cached until a package.json or the lockfile changes.
# When a new app/package is added to the workspace, add its package.json here too (npm ci
# validates the lockfile against every workspace manifest).
COPY package.json package-lock.json .npmrc ./
COPY packages/common/package.json packages/common/
COPY packages/contracts/package.json packages/contracts/
COPY packages/geo/package.json packages/geo/
COPY apps/user/package.json apps/user/
COPY apps/gateway/package.json apps/gateway/
COPY apps/routing/package.json apps/routing/
COPY apps/driver/package.json apps/driver/
COPY apps/rider/package.json apps/rider/
COPY apps/trip/package.json apps/trip/
COPY apps/matching/package.json apps/matching/
COPY apps/simulator/package.json apps/simulator/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
ARG APP
# Build the shared packages first (the app compiles against their dist/ typings), then the app.
RUN test -n "$APP" \
 && npm run build --workspace=packages/common --workspace=packages/contracts --workspace=packages/geo \
 && npm run build --workspace=apps/${APP}

FROM build AS prod
ARG APP
# Re-install with production dependencies only. The apps do not declare the @rideshare/*
# packages in their package.json (they resolve through the root workspace links), so the
# packages are selected explicitly: npm then installs their prod deps and keeps the links.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --include-workspace-root=false \
      --workspace=apps/${APP} --workspace=packages/common \
      --workspace=packages/contracts --workspace=packages/geo
# Assemble only what runs: manifests, compiled output and runtime assets (e.g. SQL migrations).
RUN mkdir -p /out/apps/${APP} /out/packages \
 && cp package.json /out/ \
 && cp apps/${APP}/package.json /out/apps/${APP}/ \
 && cp -r apps/${APP}/dist /out/apps/${APP}/ \
 && if [ -d apps/${APP}/drizzle ]; then cp -r apps/${APP}/drizzle /out/apps/${APP}/; fi \
 && for p in common contracts geo; do \
      mkdir -p /out/packages/$p && cp packages/$p/package.json /out/packages/$p/ \
      && cp -r packages/$p/dist /out/packages/$p/; \
    done

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod --chown=node:node /app/node_modules ./node_modules
COPY --from=prod --chown=node:node /out/ ./
# Writable by the non-root user; a named volume mounted here inherits this ownership.
RUN mkdir /keys && chown node:node /keys
USER node
WORKDIR /app/apps/${APP}
CMD ["node", "dist/main.js"]
