# Snatcher — build stage: dependencies only
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js package.json ./
COPY src ./src
COPY views ./views
COPY public ./public

# Snatcher — runtime stage: app + ffmpeg + yt-dlp, non-root
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache ffmpeg curl \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && yt-dlp --version
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src
COPY --from=build /app/views ./views
COPY --from=build /app/public ./public
ENV NODE_ENV=production
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
