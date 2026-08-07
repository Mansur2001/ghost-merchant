FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 3000

# Run migrations, then boot. Migrations are idempotent (IF NOT EXISTS + tracking table).
CMD ["sh", "-c", "node src/db/migrate.js && node src/index.js"]
