FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/joolay/umbrel-apps"
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV PORT=3900 API_PORT=3901 DATA_DIR=/data NODE_ENV=production
EXPOSE 3900 3901
VOLUME /data
CMD ["node", "server.js"]
