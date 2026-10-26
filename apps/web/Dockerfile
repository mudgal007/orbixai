# Build from the repo root: docker build -f apps/web/Dockerfile .
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
ENV NEXT_STANDALONE=true NEXT_TELEMETRY_DISABLED=1
# ORBIX_API_INTERNAL_URL is read at build time by the rewrite config.
ARG ORBIX_API_INTERNAL_URL=http://api:4000
ENV ORBIX_API_INTERNAL_URL=$ORBIX_API_INTERNAL_URL
RUN pnpm turbo run build --filter=@orbix/web...

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
