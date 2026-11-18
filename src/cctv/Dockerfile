FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/joolay/umbrel-apps"
# ffmpeg turns each recorder's RTSP video into the pictures the wall shows.
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY server.js devices.js store.js streams.js ws.js pocketbase.js activity.js guardians.js guardians-legacy.js portal-client.js package.json ./
COPY public ./public
ENV PORT=3902 DATA_DIR=/data NODE_ENV=production
EXPOSE 3902
VOLUME /data
CMD ["node", "server.js"]
