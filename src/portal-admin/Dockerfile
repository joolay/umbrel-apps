FROM node:22-alpine
LABEL org.opencontainers.image.source=https://github.com/joolay/umbrel-apps
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
