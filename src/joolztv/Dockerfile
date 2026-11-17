# Stage 1: build the UI twice (modern browsers + Chromium 53 for LG webOS 4). The build fails if the old-TV copy would use something Chromium 53 can't run.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY build.js ./
COPY ui ./ui
COPY public ./public
RUN node build.js

# Stage 2: the server (no npm dependencies at run time)
FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/joolay/umbrel-apps"
WORKDIR /app
COPY server.js pocketbase.js portal-client.js guardians.js guardians-legacy.js activity.js ./
COPY --from=build /src/dist ./dist
ENV PORT=3900 DATA_DIR=/data UI_DIST=/app/dist NODE_ENV=production
EXPOSE 3900
VOLUME /data
CMD ["node", "server.js"]
