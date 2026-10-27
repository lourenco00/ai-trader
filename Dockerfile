FROM node:22-bookworm-slim

WORKDIR /app

# Dependencies first, so rebuilds are quick when only code changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Build the village UI once; the server serves it from web/dist.
RUN npm run build

ENV NODE_ENV=production \
    TZ=UTC

# The default process is the main fund. docker-compose.yml starts the others with their own command.
CMD ["npx", "tsx", "server/index.ts"]
