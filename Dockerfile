FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/claude-protocol/package.json packages/claude-protocol/package.json
COPY packages/protocol-mapper/package.json packages/protocol-mapper/package.json
COPY packages/chatgpt-backend/package.json packages/chatgpt-backend/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY package.json pnpm-workspace.yaml ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@chatgpt-to-claude/api", "start"]
