# syntax=docker/dockerfile:1.7

# ---- builder: compile better-sqlite3 against the same libc the runtime uses
FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Skip Puppeteer's bundled Chrome download — runtime image uses system chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ---- runtime
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      ca-certificates \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    DB_PATH=/data/crash_results.db

RUN groupadd --system app \
    && useradd --system --gid app --home-dir /home/app --create-home app \
    && mkdir -p /app /data \
    && chown -R app:app /app /data

WORKDIR /app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json capture.js ./
COPY --chown=app:app public ./public

USER app

VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "capture.js"]
