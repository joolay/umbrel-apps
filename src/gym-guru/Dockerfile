# Stage 1: fetch the camera pose model and its WebAssembly files once, at build time, so the app never loads anything from another website
# (it works offline once installed, and no video or picture ever leaves the phone).
FROM node:22-alpine AS vendor
RUN apk add --no-cache curl ca-certificates
WORKDIR /v
RUN npm install --no-audit --no-fund --omit=dev @mediapipe/tasks-vision@^0.10.0 \
 && mkdir -p /out/wasm \
 && cp node_modules/@mediapipe/tasks-vision/vision_bundle.mjs /out/ \
 && cp node_modules/@mediapipe/tasks-vision/wasm/* /out/wasm/ \
 && curl -fsSL -o /out/pose_landmarker_lite.task https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task \
 && test -s /out/pose_landmarker_lite.task && ls -la /out /out/wasm

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/joolay/umbrel-apps"
WORKDIR /app
COPY server.js pocketbase.js activity.js portal-client.js quick-server.js package.json ./
COPY public ./public
COPY --from=vendor /out ./public/vendor
ENV PORT=3925 DATA_DIR=/data NODE_ENV=production
EXPOSE 3925
VOLUME /data
CMD ["node", "server.js"]
