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

# Build with dev dependencies, then keep only what runs.
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile \
 && pnpm build \
 && CI=true pnpm install --prod --frozen-lockfile

ENV CAM_GUARD_MODELS_DIR=/data/models \
    NODE_ENV=production
VOLUME /data

ENTRYPOINT ["node", "/app/apps/bot/dist/cli.js"]
CMD ["run", "--config", "/config/bot.yaml"]
