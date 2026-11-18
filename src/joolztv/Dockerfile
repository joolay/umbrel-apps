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
RUN apk add --no-cache ffmpeg      # subtitle auto-sync listens to the file's audio
WORKDIR /app
COPY server.js subsync.js streamcfg.js thumbs.js marks.js community.js tmdb.js make-clips.js pocketbase.js portal-client.js guardians.js guardians-legacy.js activity.js ./
# the server shares this one file with the UI (it builds the Sources address for Notify me); every file the server require()s must be listed here
COPY ui/js/sources.js ./ui/js/sources.js
COPY --from=build /src/dist ./dist
# the first-run device check plays these 2-second clips; one that can't be encoded here is just left out of the check
RUN node make-clips.js /app/devtest || true
ENV PORT=3900 DATA_DIR=/data UI_DIST=/app/dist NODE_ENV=production
EXPOSE 3900
VOLUME /data
CMD ["node", "server.js"]
