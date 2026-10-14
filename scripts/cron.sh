#!/bin/sh
# Run one timeclock command inside the Playwright image. Called from crontab
# on a machine in the campus network, because GitHub's scheduled runs can
# start hours late. Keep the image tag in sync with the playwright version in
# package.json.
#
# Usage: scripts/cron.sh <signin|signout|status> [options]
set -eu
cd "$(dirname "$0")/.."
mkdir -p logs
exec >>logs/cron.log 2>&1
echo "=== $(date '+%F %T') $*"
exec flock -w 3600 .cron.lock docker run --rm --init --ipc=host \
	--user "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$PWD:/app" -w /app \
	mcr.microsoft.com/playwright:v1.64.0-noble \
	node --env-file=.env src/index.js "$@"
