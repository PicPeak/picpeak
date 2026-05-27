FROM node:22-alpine AS builder

# Add build arguments
ARG CACHEBUST=1
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION

# Add labels for GitHub Container Registry
LABEL org.opencontainers.image.source="https://github.com/the-luap/picpeak"
LABEL org.opencontainers.image.description="PicPeak Backend Service"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (--omit=dev replaces deprecated --only=production)
RUN npm ci --omit=dev

# Copy application files
COPY . .

# Production stage
FROM node:22-alpine

WORKDIR /app

# Upgrade all packages to fix security vulnerabilities (OpenSSL, libexpat, BusyBox CVEs)
RUN apk upgrade --no-cache

# Upgrade npm to fix tar, minimatch, brace-expansion CVEs in npm's own deps
# Pin to 10.x to stay compatible with Node 22 Alpine (npm 11.x has dependency issues)
RUN npm install -g npm@10

# Install dumb-init for proper signal handling, postgresql-client for database
# checks, ffmpeg for video upload support, and su-exec for the root → nodejs
# privilege drop in wait-for-db.sh (see #484: container starts as root so it
# can chown bind-mounted host volumes to UID 1001, then re-execs as nodejs
# before running the app). Alpine's ffmpeg package ships both `ffmpeg` and
# `ffprobe` built natively against musl libc — the npm
# `@ffmpeg-installer/ffmpeg` binary is glibc-built and (a) doesn't reliably
# run on Alpine and (b) only includes ffmpeg, not ffprobe (which the video
# pipeline calls via fluent-ffmpeg.ffprobe()).
RUN apk add --no-cache dumb-init postgresql-client ffmpeg su-exec

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Copy from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs . .

# Ensure all source files are readable and wait script is executable
RUN chmod -R a+r /app && chmod +x wait-for-db.sh

# Create necessary directories
RUN mkdir -p storage/events/active storage/events/archived storage/thumbnails data logs && \
    chown -R nodejs:nodejs storage data logs

# No USER directive — the container starts as root so wait-for-db.sh can
# chown bind-mounted host directories to UID 1001 before dropping privs
# via su-exec. See #484 for the fresh-install restart loop this avoids.

EXPOSE 3000

# Healthcheck hits the same /health endpoint already used by the e2e
# runner and by the docker-compose `depends_on: condition: service_healthy`
# checks. wget is part of the Alpine base image. Long start-period covers
# the wait-for-db.sh delay before the Node process starts listening.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["./wait-for-db.sh", "node", "server.js"]
