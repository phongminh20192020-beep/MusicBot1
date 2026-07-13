FROM node:22-alpine
# cache-bust: 2026-06-23b
WORKDIR /app

# ffmpeg is required at runtime for MV video streaming.
# yt-dlp powers /mv download (YouTube + most video sites).
# python3/py3-pip/make/g++ are required to build native deps and install yt-dlp.
RUN apk add --no-cache ffmpeg python3 py3-pip make g++ \
    && pip install --no-cache-dir --break-system-packages yt-dlp

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY src ./src
ENV NODE_ENV=production

# Web dashboard (see src/dashboard) — informational only, doesn't change how the bot runs.
EXPOSE 3000

CMD ["node", "src/index.js"]
