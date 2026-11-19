FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/joolay/umbrel-apps"
WORKDIR /app
COPY server.js lists.js github.js pocketbase.js activity.js portal-client.js package.json ./
COPY public ./public
ENV PORT=3915 DATA_DIR=/data NODE_ENV=production
EXPOSE 3915
VOLUME /data
CMD ["node", "server.js"]
