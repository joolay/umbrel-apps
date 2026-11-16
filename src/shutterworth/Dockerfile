FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/joolay/umbrel-apps"
WORKDIR /app
COPY server.js pocketbase.js activity.js portal-client.js guardians-legacy.js guardians.js inventory-store.js sharing.js make-admin.js package.json ./
COPY public ./public
ENV PORT=3880 DATA_DIR=/data NODE_ENV=production
EXPOSE 3880
VOLUME /data
CMD ["node", "server.js"]
