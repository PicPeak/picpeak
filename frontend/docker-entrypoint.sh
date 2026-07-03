#!/bin/sh
# Frontend container entrypoint (#521).
#
# Renders /usr/share/nginx/html/index.html from a build-time .tpl
# snapshot, substituting BRAND_TITLE / BRAND_DESCRIPTION env vars into
# the static HTML head. This is what self-hosters running the pre-built
# GHCR image use to brand their link-preview fallback — see the matching
# comment in frontend/index.html for the three-path architecture
# (per-event OG endpoint, crawler-detected SPA shell, and this static
# fallback that catches WhatsApp Business / Twilio / LinkPreview).
#
# Re-runs on every container start. The .tpl is the immutable source so
# changing BRAND_TITLE in compose env and `docker compose up -d frontend`
# is enough — no rebuild required.
#
# Locked to BRAND_TITLE + BRAND_DESCRIPTION explicitly (rather than
# letting envsubst expand every ${...} it finds) so the JS bundle's
# template literals in /assets/*.js stay untouched if anyone ever
# accidentally points the substitution at them.
set -eu

: "${BRAND_TITLE:=PicPeak}"
: "${BRAND_DESCRIPTION:=Photo gallery shared with PicPeak.}"

export BRAND_TITLE BRAND_DESCRIPTION

TEMPLATE=/usr/share/nginx/html/index.html.tpl
RENDERED=/usr/share/nginx/html/index.html

if [ -f "$TEMPLATE" ]; then
  envsubst '${BRAND_TITLE} ${BRAND_DESCRIPTION}' < "$TEMPLATE" > "$RENDERED"
else
  # Template missing — image build skipped the .tpl rename for some
  # reason. Don't crash: nginx can still serve whatever is at
  # $RENDERED (probably the unsubstituted output of `npm run build`).
  # Log loudly so it's visible during boot.
  echo "[frontend-entrypoint] WARN: $TEMPLATE missing; serving $RENDERED as-is." >&2
fi

exec "$@"
