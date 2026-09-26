# cam-guard bot.
#
#   docker build -t cam-guard .
#   docker run -v ./my-config:/config -v cam-guard-data:/data cam-guard
#
# /config holds bot.yaml and whatever it references (policy, source and
# adapters modules); /data holds the model cache and the evidence.

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# Build with dev dependencies, then keep only what runs: production
# dependencies, ONNX Runtime binaries for this platform only (the package ships
# every OS and architecture), and no package-manager store or cache. All in one
# layer, or the deleted files would still weigh on the image.
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile \
 && pnpm build \
 && CI=true pnpm install --prod --frozen-lockfile \
 && ORT="$(cd packages/detector-nudenet && node -p "require('path').dirname(require.resolve('onnxruntime-node/package.json'))")" \
 && find "$ORT/bin" -mindepth 3 -maxdepth 3 -type d ! -path "*/$(node -p process.platform)/$(node -p process.arch)" -exec rm -rf {} + \
 && rm -rf /root/.local/share/pnpm /root/.cache

ENV CAM_GUARD_MODELS_DIR=/data/models \
    NODE_ENV=production
VOLUME /data

# Not root: the bot runs as `node` (the image's own user); docker-entrypoint.sh
# only gives /data to it first. /config is read-only and only read.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh", "node", "/app/apps/bot/dist/cli.js"]
CMD ["run", "--config", "/config/bot.yaml"]
