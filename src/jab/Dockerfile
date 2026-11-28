# One image, two apps (like the JoolzApp Dashboard and Portal Admin): the JAB dashboard runs `node server.js` (default);
# JAB Admin runs the same image with `node admin.js`. No dependencies, nothing from the family JoolzApp network.
FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/joolay/umbrel-apps"
WORKDIR /app
COPY server.js admin.js accounts.js config.js package.json ./
COPY public ./public
COPY public-admin ./public-admin
ENV PORT=3927 DATA_DIR=/data NODE_ENV=production
EXPOSE 3927
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
