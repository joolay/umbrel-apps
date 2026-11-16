FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/joolay/umbrel-apps"
WORKDIR /app
COPY server.js pocketbase.js activity.js menus.js family.js family-legacy.js guardians.js guardians-legacy.js portal-client.js package.json ./
COPY public ./public
ENV PORT=3893 DATA_DIR=/data NODE_ENV=production
EXPOSE 3893
VOLUME /data
CMD ["node", "server.js"]
