FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/joolay/umbrel-apps"
WORKDIR /app
COPY server.js pocketbase.js package.json ./
ENV PORT=3897 DATA_DIR=/data NODE_ENV=production
EXPOSE 3897
VOLUME /data
CMD ["node", "server.js"]
