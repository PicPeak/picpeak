#!/bin/bash
set -e

# DEPRECATED — do not use. Superseded by scripts/picpeak-setup.sh.
#
# This script predates the current deployment layout and no longer works. It
# refers to two files that do not exist (docker-compose.prod.yml and
# scripts/setup-ssl.sh), and its `sed` calls now match the COMMENTED lines in
# the current .env.example, so they produce `#JWT_SECRET=<random>` — still
# commented, so no secret is ever set. It fails silently rather than loudly,
# which is the worst outcome for an installer.
#
# Nothing in the repository references it. It is kept as a stub only so an old
# bookmark or copied command gets a signpost instead of a broken install. The
# old body is gone on purpose: it fetched get.docker.com and a `latest`
# docker-compose binary and ran them unverified, and dead code like that is one
# deleted `exit` away from being live again.
cat >&2 <<'DEPRECATED'
scripts/install.sh is deprecated and does nothing.

Use the current installer instead:

    ./scripts/picpeak-setup.sh

Or run the stack directly — see the Quick Start in README.md, or
docs/single-container.md for the single-container image.
DEPRECATED
exit 1
