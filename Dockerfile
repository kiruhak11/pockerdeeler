FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl bash netcat-openbsd

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/prisma ./prisma
COPY package.json ./package.json
COPY scripts ./scripts

RUN chmod +x scripts/*.sh

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
