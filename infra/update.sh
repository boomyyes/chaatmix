#!/bin/bash
# Run as root every 5 minutes by /usr/local/bin/chaat-update (boot.sh), always from the newest tested commit.
# Builds the `deploy` commit (only CI-passed commits land there) in its own folder while the old version keeps
# running, waits until no stream is live, switches over, and switches back if the new version doesn't come up.
set -euo pipefail
exec 9>/run/chaat-update.lock; flock -n 9 || exit 0
as() { runuser -u chaat -- env HOME=/home/chaat "$@"; }
SRC=/opt/chaat-mix REL=/opt/chaat-mix-releases CUR=/opt/chaat-mix-current
health() { curl -fsS --max-time 5 http://127.0.0.1:3000/health; }

SHA=$(git -C "$SRC" rev-parse origin/deploy)
DIR=$REL/$SHA
OLD=$(readlink "$CUR" || true)
[ "$OLD" = "$DIR" ] && exit 0
[ -f "$DIR.failed" ] && exit 0 # tried and rolled back: wait for the next commit
if [ "${1:-}" != force ] && health | grep -q '"state":"live"'; then echo "$(date) $SHA waits: a stream is live"; exit 0; fi

if [ ! -f "$DIR/app/build/index.js" ]; then
	echo "$(date) building $SHA"
	rm -rf "$DIR" && mkdir -p "$DIR" && chown chaat "$DIR"
	git -C "$SRC" archive "$SHA" | as tar -x -C "$DIR"
	(cd "$DIR/app" && as npm ci --no-audit --no-fund && as npm run build) || { touch "$DIR.failed"; exit 1; }
fi

ln -sfn "$DIR" "$CUR.new" && mv -Tf "$CUR.new" "$CUR"
systemctl restart chaat-mix
for _ in $(seq 1 30); do health > /dev/null 2>&1 && break; sleep 2; done
if ! health > /dev/null 2>&1; then
	echo "$(date) $SHA did not come up: rolling back to $OLD"
	touch "$DIR.failed"
	if [ -n "$OLD" ]; then ln -sfn "$OLD" "$CUR.new" && mv -Tf "$CUR.new" "$CUR" && systemctl restart chaat-mix; fi
	exit 1
fi
echo "$(date) running $SHA"
# Keep the running release and the one before it (the rollback target).
# $REL is root-owned, so only update.sh creates entries in it.
for d in $(ls -1dt "$REL"/*/ | tail -n +3); do if [ "${d%/}" != "$OLD" ]; then rm -rf -- "${d%/}"; fi; done
