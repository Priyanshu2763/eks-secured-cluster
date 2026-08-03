# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so the dependency layer caches independently of source
# changes. Without this every source edit re-runs a full npm ci.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so only runtime packages get copied forward.
RUN npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
# Distroless: no shell, no package manager, no busybox. An attacker with RCE
# lands in an image with nothing to pivot with. The trade-off is that you
# cannot `exec` into it to debug - use the platform's exec facility against a
# sidecar, or temporarily swap to the :debug tag.
FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Runs as the built-in `nonroot` user (uid 65532). Combined with
# readOnlyRootFilesystem in the task/pod spec, the container cannot write
# anywhere except an explicitly mounted tmpfs.
USER nonroot

COPY --from=build --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
COPY --from=build --chown=nonroot:nonroot /app/package.json ./package.json

EXPOSE 8080

# No HEALTHCHECK instruction on purpose: the orchestrator owns health checking
# (ALB target group / container healthCheck / kubelet probes), and a duplicate
# in-image check just burns CPU and confuses which signal is authoritative.

CMD ["dist/server.js"]
