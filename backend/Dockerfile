FROM node:20-alpine

WORKDIR /app

# Prisma's query engine is a native binary, so the schema has to be present BEFORE
# `npm install` — the postinstall hook runs `prisma generate` and needs it.
COPY package.json ./
COPY prisma ./prisma

# `--omit=dev` would drop the prisma CLI, which the container needs at boot to run
# `prisma migrate deploy`. Keep it, then generate the client for THIS platform (musl).
RUN npm install --omit=dev --include=dev prisma @prisma/client \
 && npm install --omit=dev \
 && npx prisma generate

COPY src ./src
COPY scripts ./scripts

EXPOSE 3000

# Apply any pending migrations, then boot. `migrate deploy` only applies committed migrations
# and never generates or resets — the only Prisma migration command that is safe in production.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
