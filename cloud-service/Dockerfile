FROM node:22-slim AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json* ./
COPY cloud-service/package.json cloud-service/package-lock.json* cloud-service/

# Vendored tarballs (e.g. xlsx) referenced by package.json as file:vendor/...
# must be present before `npm ci` resolves them.
COPY vendor/ vendor/

# Install root dependencies (needed for shared src/main and src/shared code)
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps

# Install cloud-service build dependencies (esbuild needed for build)
WORKDIR /app/cloud-service
RUN npm ci

# Copy source code
WORKDIR /app
COPY src/ src/
COPY packages/ packages/
COPY cloud-service/ cloud-service/
COPY super-mcp/ super-mcp/
COPY resources/connector-catalog.json resources/connector-catalog.json
COPY resources/mcp/ resources/mcp/
COPY scripts/lib/discoverElectronImports.mjs scripts/lib/discoverElectronImports.mjs
COPY scripts/build-bundled-mcps.mjs scripts/build-bundled-mcps.mjs
COPY scripts/build-bundled-mcps-utils.mjs scripts/build-bundled-mcps-utils.mjs
COPY scripts/mcp-config.json scripts/mcp-config.json
# print-cloud-schema-fingerprint.ts: invoked by cloud-service/build.mjs (line ~161)
# as a tsx subprocess to bake the schema fingerprint into dist/default-lkg.json.
# Reads its imports from /app/src/core/* which is already COPYed above.
COPY scripts/print-cloud-schema-fingerprint.ts scripts/print-cloud-schema-fingerprint.ts

# Build bundled MCP servers (generates resources/mcp-generated/*.cjs bundles)
# Each MCP: npm install → tsc → esbuild bundle → single server.cjs
# This makes OAuth-based MCPs (Google Workspace, Slack, etc.) available in cloud
# Install esbuild at root so the build script can resolve it via import('esbuild')
RUN npm install --no-save --legacy-peer-deps esbuild && \
    node scripts/build-bundled-mcps.mjs --force

# Stage unbundled runtime MCPs into a flat directory for a single COPY in production.
# Bundled MCPs (listed in mcp-config.json) run from mcp-generated/ — their source dirs
# are NOT needed at runtime. This script copies only unbundled MCPs that have a server
# entry point, skipping desktop-only and non-functional dirs.
RUN node -e " \
  const fs = require('fs'); const path = require('path'); \
  const src = '/app/resources/mcp'; \
  const dest = '/app/resources/mcp-runtime'; \
  const EXCLUDE = new Set(['bamboohr', 'electron-debug', 'granola']); \
  const config = JSON.parse(fs.readFileSync('/app/scripts/mcp-config.json', 'utf8')); \
  if (!Array.isArray(config.bundledMcps)) { \
    console.error('Invalid mcp-config.json: missing bundledMcps array'); process.exit(1); \
  } \
  const bundled = new Set(config.bundledMcps); \
  fs.mkdirSync(dest, { recursive: true }); \
  for (const name of fs.readdirSync(src)) { \
    if (EXCLUDE.has(name) || bundled.has(name)) continue; \
    const dir = path.join(src, name); \
    if (!fs.statSync(dir).isDirectory()) continue; \
    const hasEntry = ['server.cjs','server.mjs','build/index.js'] \
      .some(f => fs.existsSync(path.join(dir, f))); \
    if (!hasEntry) continue; \
    fs.cpSync(dir, path.join(dest, name), { recursive: true }); \
  } \
  const names = fs.readdirSync(dest).sort(); \
  console.log('Staged ' + names.length + ' runtime MCPs: ' + names.join(', ')); \
"

# Build super-mcp (TypeScript → dist/)
WORKDIR /app/super-mcp
RUN npm ci --ignore-scripts --legacy-peer-deps && npx tsc

# Copy and build shared cloud-client package
COPY cloud-client/ /app/cloud-client/
WORKDIR /app/cloud-client
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps

# Web companion SPA -- build in isolated /build-web to avoid root lockfile interference
COPY cloud-client/src/ /build-web/cloud-client/src/
COPY cloud-client/package.json /build-web/cloud-client/
COPY packages/shared/ /build-web/packages/shared/
# cloud-client imports @core/* and @shared/* — copy source trees so Vite can
# resolve the aliases defined in web-companion/vite.config.ts.
COPY src/core/ /build-web/src/core/
COPY src/shared/ /build-web/src/shared/
COPY tsconfig.base.json /build-web/
COPY web-companion/ /build-web/web-companion/
# web-companion/vite.config.ts imports RENDERER_SINGLETON_DEPS from this file via
# `../scripts/renderer-singleton-deps.mjs` — keep the same relative path inside the
# isolated /build-web build root so the import resolves.
COPY scripts/renderer-singleton-deps.mjs /build-web/scripts/renderer-singleton-deps.mjs
# Install shared package deps (diff etc.) so Vite can resolve imports from
# packages/shared source files referenced transitively via cloud-client.
WORKDIR /build-web/packages/shared
RUN npm install --omit=dev --ignore-scripts --legacy-peer-deps
# Install cloud-client deps (heic-to etc.) so Vite can resolve transitive imports
# from cloud-client source files referenced via the @rebel/cloud-client alias.
WORKDIR /build-web/cloud-client
RUN npm install --omit=dev --ignore-scripts --legacy-peer-deps
WORKDIR /build-web/web-companion
RUN npm install --ignore-scripts --legacy-peer-deps && \
    ./node_modules/.bin/vite build

# Pre-cache the cloud embedding model so first boot doesn't download ONNX weights.
# Switch to /app/cloud-service so Node's CJS resolver finds @huggingface/transformers
# in cloud-service/node_modules (it's a cloud-service-only dep, not a web-companion one).
# Transformers.js (@huggingface/transformers) does NOT honour the Python-side
# HF_HOME / TRANSFORMERS_CACHE env vars — its cache directory is controlled by the
# library-exported `env.cacheDir` mutable property. Setting that programmatically
# before the pipeline() call routes the model files to /app/cloud-service/models so
# the next-stage COPY --from=builder /app/cloud-service/models can pick them up.
WORKDIR /app/cloud-service
# Retries with backoff — huggingface.co intermittently 429s during CI image builds
# (the recurring "Build Cloud Service Image" flake). See the script header.
RUN node scripts/precache-embedding-model.mjs

# Build cloud-service using the canonical build script (single source of truth)
# BUILD_COMMIT / BUILD_DATE are passed from `fly deploy --build-arg` or CI
# because git is unavailable in the Docker builder stage.
ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown
WORKDIR /app/cloud-service
RUN BUILD_COMMIT=${BUILD_COMMIT} BUILD_DATE=${BUILD_DATE} node build.mjs

# --- Production stage ---
# Layers ordered by change frequency: rarely-changing deps first, frequently-changing code last.
# This maximizes Docker layer cache hits — a code-only deploy pushes only the final ~14MB layer.
FROM node:22-slim

# Install ffmpeg for audio chunking and duration detection (required for meeting recordings).
# Must NOT use --no-install-recommends: ffmpeg binary needs libavcodec/libavformat/etc shared
# libraries which are recommended deps, not hard deps. Without them ffmpeg hangs on startup.
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash rebel

WORKDIR /app

# Layer 1: Root production dependencies (changes rarely — only when package-lock.json changes)
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/cloud-service/models/ /app/cloud-service/models/
COPY --from=builder /app/cloud-service/node_modules/ cloud-service/node_modules/
COPY --from=builder /app/cloud-service/package.json cloud-service/

# Layer 2: Super-MCP runtime — only dist/ and node_modules/, not src/ (changes occasionally)
COPY --from=builder /app/super-mcp/dist/ super-mcp/dist/
COPY --from=builder /app/super-mcp/node_modules/ super-mcp/node_modules/
COPY --from=builder /app/super-mcp/package.json super-mcp/

# Layer 3: Bundled MCP runtime artifacts (changes when MCPs are added/updated — weekly)
COPY --from=builder /app/resources/mcp-generated/ resources/mcp-generated/

# Layer 4: Hand-written MCPs needed at runtime (changes weekly)
# Auto-discovered by the staging script in the builder stage. Adding a new MCP
# with a server entry point (server.cjs/mjs or build/index.js) requires zero
# Dockerfile changes — it's picked up automatically. See EXCLUDE list in builder.
COPY --from=builder /app/resources/mcp-runtime/ resources/mcp/
COPY --from=builder /app/resources/connector-catalog.json resources/connector-catalog.json

# Layer 5: Web companion SPA + rebel-system (changes with releases — weekly)
COPY --from=builder /build-web/web-companion/dist/ data/web-app/
COPY rebel-system/ rebel-system/

# Layer 6: Cloud service bundle — last layer, changes every deploy (~14MB)
COPY --from=builder /app/cloud-service/dist/server.mjs cloud-service/dist/server.mjs
# entry.mjs: the pre-bootstrap watchdog shim (Stage C2 of
# docs/plans/260510_cloud_image_rollback_defense_in_depth.md). Replaces
# server.mjs as the container CMD so the watchdog can react to a previous
# silent boot crash before server.mjs's module-init code runs.
COPY --from=builder /app/cloud-service/dist/entry.mjs cloud-service/dist/entry.mjs
# default-lkg.json: first-boot fallback for the pre-bootstrap watchdog
# (Stage C1 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md).
# Tiny (~200B); pairs with server.mjs so they're always rebuilt together.
COPY --from=builder /app/cloud-service/dist/default-lkg.json cloud-service/dist/default-lkg.json

# Create data directory owned by non-root user
RUN mkdir -p /data/sessions /data/workspace /data/logs /data/mcp && \
    chown -R rebel:rebel /data /app

USER rebel

ENV REBEL_USER_DATA=/data
ENV IS_CLOUD_SERVICE=1
ENV TRANSFORMERS_CACHE=/app/cloud-service/models
ENV HF_HOME=/app/cloud-service/models
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const h=require('http');h.get('http://localhost:8080/api/health',(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{const j=JSON.parse(d);process.exit(j.status==='ok'?0:1)})}).on('error',()=>process.exit(1))"

CMD ["node", "cloud-service/dist/entry.mjs"]
