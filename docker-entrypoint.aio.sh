#!/bin/sh
# All-in-one entrypoint (#1042).
#
# The compose deployment renders index.html in the frontend container via
# frontend/docker-entrypoint.sh. This image runs no nginx, so that never
# happens — and Vite does not substitute ${BRAND_TITLE} at build time, so the
# built index.html ships the placeholders verbatim. Without this step every
# AIO install would serve a literal "${BRAND_TITLE}" as its <title> and in
# every og:/twitter: card.
#
# Kept as a startup step rather than a build-time sed so BRAND_TITLE and
# BRAND_DESCRIPTION behave the same way they do for the frontend image:
# set the env var, restart the container, new branding. Baking them at build
# would silently make those variables inert.
set -e

TEMPLATE=/app/public/index.html.template
RENDERED=/app/public/index.html

if [ -f "$TEMPLATE" ]; then
  # Same defaults frontend/docker-entrypoint.sh applies when the vars are unset.
  : "${BRAND_TITLE:=PicPeak}"
  : "${BRAND_DESCRIPTION:=Photo gallery shared with PicPeak.}"

  # Substitute ONLY these two, exactly like the frontend entrypoint: letting
  # envsubst expand every ${...} it finds would mangle unrelated content.
  export BRAND_TITLE BRAND_DESCRIPTION
  envsubst '${BRAND_TITLE} ${BRAND_DESCRIPTION}' < "$TEMPLATE" > "$RENDERED"

  # The app runs as UID 1001 after the privilege drop below; the render happens
  # while we are still root, so hand the result over explicitly.
  chown nodejs:nodejs "$RENDERED" 2>/dev/null || true
fi

exec ./wait-for-db.sh "$@"
