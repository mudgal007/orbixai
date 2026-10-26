# Build from the repo root: docker build -f apps/worker/Dockerfile .
FROM node:20-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@orbix/worker...

FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
USER node
CMD ["node", "apps/worker/dist/main.js"]
