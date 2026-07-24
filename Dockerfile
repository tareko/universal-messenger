# universal-messenger — single-image build (server + built web UI)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build:web

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# Data (SQLite, media, provider sessions) lives in /app/data — mount a volume.
VOLUME ["/app/data"]
EXPOSE 8317
CMD ["npm", "start"]
