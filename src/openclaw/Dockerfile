# OpenClaw for the JoolzApp store: upstream's own build plus our startup files.
# This is NOT a stand-alone Dockerfile: prepare.sh appends it to upstream's Dockerfile, whose last stage is named `openclaw-runtime`.
# Build context = the prepared folder (upstream checkout + joolz/). Run `sh prepare.sh <folder>` and then `docker build <folder>`.
FROM openclaw-runtime AS joolz
LABEL org.opencontainers.image.source=https://github.com/joolay/umbrel-apps
USER root
COPY joolz/ /app/joolz/
RUN chmod 755 /app/joolz/start.sh
# All of OpenClaw's state (config, sessions, workspace, the gateway token) lives in the one volume Umbrel keeps across updates.
ENV OPENCLAW_STATE_DIR=/data/state OPENCLAW_CONFIG_PATH=/data/state/openclaw.json
VOLUME /data
EXPOSE 18789
# Starts as root only to give /data to the `node` user, then runs everything as `node` (see joolz/start.sh). Upstream's HEALTHCHECK is inherited.
ENTRYPOINT ["/app/joolz/start.sh"]
CMD ["node", "openclaw.mjs", "gateway"]
