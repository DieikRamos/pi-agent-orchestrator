# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts vitest.config.ts ./
COPY src ./src
COPY web ./web
COPY docs ./docs
COPY examples ./examples
COPY scripts ./scripts
COPY README.md ./

RUN npm run build \
 && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git ripgrep openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*' 

WORKDIR /app
ENV NODE_ENV=production \
    HOME=/root \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_BROKER_PORT=8787 \
    PI_ORCHESTRATOR_WORKDIR=/workspace

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY --from=build /app/examples ./examples
COPY --from=build /app/README.md ./README.md

# The container listens on 0.0.0.0; docker-compose publishes it only on host
# loopback. PI_ORCHESTRATOR_ALLOW_REMOTE_BIND=1 is the explicit broker guard.
CMD ["sh", "-c", "exec node /app/dist/broker/main.js --workdir \"${PI_ORCHESTRATOR_WORKDIR:-/workspace}\" --config \"${PI_AGENT_CONFIG:-/workspace/.pi/agents.yml}\" --state-dir \"${PI_ORCHESTRATOR_STATE_DIR:-/workspace/.pi/agent-orchestrator}\" --host \"${PI_ORCHESTRATOR_BIND_HOST:-0.0.0.0}\" --port \"${PI_BROKER_PORT:-8787}\""]

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "const p=process.env.PI_BROKER_PORT||8787; fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
