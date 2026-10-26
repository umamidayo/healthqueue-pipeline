# HealthQueue API container image.
#
# Base images are pinned by digest (Dependabot keeps them current) so a build
# is a function of this file plus the source tree, not of whatever a mutable
# tag pointed to that day. See docs/supply-chain-security.md.
#
# No `# syntax=` directive: BuildKit's built-in Dockerfile frontend is used,
# which avoids pulling an extra, separately-versioned frontend image.

ARG BUILD_IMAGE=node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8

# --- deps: resolve production dependencies from the lockfile only ----------
FROM ${BUILD_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts blocks install-time code execution from packages, the most
# common npm supply-chain attack vector. mkdir keeps COPY valid with zero deps.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && mkdir -p node_modules \
 && npm cache clean --force

# --- runtime: distroless, non-root, no shell, no package manager -----------
FROM ${RUNTIME_IMAGE}
ARG BUILD_VERSION=dev
ARG BUILD_REVISION=unknown
ENV NODE_ENV=production \
    BUILD_VERSION=${BUILD_VERSION} \
    BUILD_REVISION=${BUILD_REVISION}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER 65532:65532
EXPOSE 8080
# distroless/nodejs uses `node` as its entrypoint.
CMD ["src/server.js"]
