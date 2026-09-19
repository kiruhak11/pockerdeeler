FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl bash netcat-openbsd

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ARG RELEASE_ID=development
ENV RELEASE_ID=$RELEASE_ID
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/prisma ./prisma
COPY package.json ./package.json
COPY scripts ./scripts

RUN chmod +x scripts/*.sh

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
