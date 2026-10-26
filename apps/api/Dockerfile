# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:20-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@orbix/api...

FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
USER node
EXPOSE 4000
# Apply migrations, then serve. (Run migrations as a separate release step in multi-instance deployments.)
CMD ["sh", "-c", "cd packages/db && npx prisma migrate deploy && cd /repo/apps/api && node dist/main.js"]
