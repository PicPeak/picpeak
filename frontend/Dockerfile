# Build stage — node:22-alpine drops npm-bundled CVEs in older Node 20
# (picomatch, ip-address, brace-expansion, @sigstore/core, tar) since the
# bundled npm version is newer in 22. Matches the backend Dockerfile base.
FROM node:22-alpine AS builder

# Add build arguments
ARG CACHEBUST=1
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION

# Add labels for GitHub Container Registry
LABEL org.opencontainers.image.source="https://github.com/PicPeak/picpeak"
LABEL org.opencontainers.image.description="PicPeak Frontend Application"
LABEL org.opencontainers.image.licenses="MIT"

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --legacy-peer-deps

# Copy source files
COPY . .

# Build the application
RUN npm run build

# Production stage (Alpine 3.23 with OpenSSL 3.5.5, patched libexpat)
FROM nginx:1.28-alpine

# Upgrade all Alpine packages for security fixes. The explicit nginx upgrade
# closes the HTTP/2 + rewrite/charset CVEs (CVE-2026-42055 / -49975 / -9256 /
# -48142, fixed in nginx 1.28.3-r4) and busts any cached layer still carrying
# the vulnerable r1 build.
RUN apk upgrade --no-cache && apk add --no-cache --upgrade nginx

# Install runtime dependencies. `gettext` provides envsubst, used by
# docker-entrypoint.sh for the BRAND_TITLE / BRAND_DESCRIPTION runtime
# substitution into index.html (#521 — runtime fix for self-hosters
# on the pre-built GHCR image who can't override at build time).
RUN apk add --no-cache curl gettext

# Remove default nginx config
RUN rm -rf /etc/nginx/conf.d/*

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built application from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Snapshot index.html as a template so the entrypoint always renders
# from a known-good source — not from its own previous substitution.
# Container restarts can change BRAND_TITLE freely; the rendered file
# is recomputed from the .tpl each time.
RUN mv /usr/share/nginx/html/index.html /usr/share/nginx/html/index.html.tpl

# Runtime entrypoint that envsubsts the template and execs nginx
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Set permissions (nginx user already exists in nginx:alpine)
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid

# Expose port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/health || exit 1

# Switch to non-root user
USER nginx

# Start nginx via the entrypoint so each container start re-renders
# index.html from the template against the current BRAND_TITLE /
# BRAND_DESCRIPTION env vars (defaults applied when unset).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
