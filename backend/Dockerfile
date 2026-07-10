FROM node:22-alpine AS builder

# Add build arguments
ARG CACHEBUST=1
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION

# Add labels for GitHub Container Registry
LABEL org.opencontainers.image.source="https://github.com/PicPeak/picpeak"
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

# Upgrade the npm CLI in the final image so its bundled deps are patched
# (sigstore 4.x, tar) — closes CVE-2026-48815 and the older @sigstore/core / tar
# Trivy alerts. Safe here: only the CLI present in the image changes. Runtime
# dependencies come from the builder stage (COPY --from=builder node_modules
# below) and the entrypoint runs node, not npm — so npm 11's install behaviour
# (the reason 10.x was pinned) never executes in this stage. npm 11 needs
# Node >=22.9, satisfied by node:22-alpine.
RUN npm install -g npm@11

# Install dumb-init for proper signal handling, postgresql-client for database
# checks, ffmpeg for video upload support, and su-exec for the root → nodejs
# privilege drop in wait-for-db.sh (see #484: container starts as root so it
# can chown bind-mounted host volumes to UID 1001, then re-execs as nodejs
# before running the app). Alpine's ffmpeg package ships both `ffmpeg` and
# `ffprobe` built natively against musl libc — the npm
# `@ffmpeg-installer/ffmpeg` binary is glibc-built and (a) doesn't reliably
# run on Alpine and (b) only includes ffmpeg, not ffprobe (which the video
# pipeline calls via fluent-ffmpeg.ffprobe()).
# fontconfig is required so `sharp` (librsvg) can rasterise SVG logos that
# contain live <text> for the CRM PDFs. Without any font installed, librsvg
# renders text as tofu boxes (□) while the vector artwork still draws — i.e.
# a "corrupted" logo on invoices/quotes. DejaVu/Liberation provide a broad
# Unicode fallback; picpeak's own brand fonts (assets/fonts/, the same files
# PDFKit + the web UI use) are registered with fontconfig further down so the
# logo's text renders in its actual typeface, not a fallback.
# poppler-utils provides `pdftoppm`, used to rasterise inbound supplier-invoice
# PDFs to flat PNGs server-side so the admin UI NEVER renders a raw (possibly
# malicious) PDF. pdftoppm does not execute embedded JS or fetch remote
# resources, so it doubles as the SSRF/phone-home guard for untrusted inbound
# documents (see docs/accounting-inbound-invoices.md).
RUN apk add --no-cache dumb-init postgresql-client ffmpeg su-exec \
    fontconfig ttf-dejavu ttf-liberation poppler-utils && \
    fc-cache -f

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Copy from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs . .

# Ensure all source files are readable and wait script is executable
RUN chmod -R a+r /app && chmod +x wait-for-db.sh

# Register picpeak's bundled brand fonts (assets/fonts/<Family>/*.ttf — the
# same files PDFKit and the web UI use) with fontconfig, so when sharp/librsvg
# rasterises an SVG logo its <text> renders in the actual brand typeface
# rather than a DejaVu/Liberation fallback. fontconfig indexes by each font's
# internal family name and recurses into the per-family subdirectories.
RUN printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>/app/assets/fonts</dir>\n</fontconfig>\n' > /etc/fonts/conf.d/99-picpeak-fonts.conf && \
    fc-cache -f /app/assets/fonts

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
