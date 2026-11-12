#!/usr/bin/env bash
# deploy-local.sh — build this checkout and hand it to the local systemd
# service (`learnharness.service`, 127.0.0.1:3100).
#
#   bash scripts/deploy-local.sh                # typecheck + tests + build + restart
#   bash scripts/deploy-local.sh --skip-tests   # fast path (typecheck + build only)
#   bash scripts/deploy-local.sh --rollback     # restore the last good server payload
#
# What it does, in order:
#   1. typecheck (tsc --noEmit)
#   2. full test suite (unless --skip-tests)
#   3. caches the currently-serving .next/standalone (rollback insurance)
#   4. next build  ->  .next/standalone
#   5. node scripts/build-server.mjs  (static assets, plugin payload, prompt
#      assets, secret/data leak guards)
#   6. systemctl --user restart + HTTP health check on :3100
#
# If the build or the health check fails, the cached payload is restored and
# the service is restarted on it — a broken commit cannot leave the server down.
#
# NOTE: `next build` rewrites .next in place, so the live server returns errors
# while the build runs (typically 2-4 minutes). There is no way around that
# without a second distDir; it is a local single-user app, so that is fine.
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

UNIT=${LH_UNIT:-learnharness}
PORT=${LH_PORT:-3100}
URL="http://127.0.0.1:${PORT}"
CACHE_DIR=${LH_DEPLOY_CACHE:-$HOME/.cache/learnharness-deploy}
BACKUP="$CACHE_DIR/standalone.prev"
SKIP_TESTS=0
MODE=deploy

for arg in "$@"; do
	case "$arg" in
		--skip-tests) SKIP_TESTS=1 ;;
		--rollback) MODE=rollback ;;
		-h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "deploy-local: unknown argument: $arg" >&2; exit 2 ;;
	esac
done

log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
die() { printf '\033[31mdeploy-local: %s\033[0m\n' "$*" >&2; exit 1; }

# systemctl --user needs the session bus even in a non-login shell.
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

restart_service() {
	systemctl --user restart "$UNIT"
}

wait_healthy() {
	local i code=000
	for i in $(seq 1 60); do
		code=$(curl -fsS -o /dev/null -w '%{http_code}' "$URL/" 2>/dev/null || true)
		if [ "$code" = "200" ]; then
			echo "healthy: $URL (HTTP 200 after ${i}s)"
			return 0
		fi
		sleep 1
	done
	echo "health check failed: last HTTP status ${code:-none}" >&2
	journalctl --user -u "$UNIT" -n 40 --no-pager >&2 || true
	return 1
}

restore_backup() {
	[ -d "$BACKUP" ] || return 1
	log "restoring last good payload from $BACKUP"
	rm -rf .next/standalone
	mkdir -p .next
	cp -a "$BACKUP" .next/standalone
	restart_service
	wait_healthy || die "restored payload is not healthy either — check journalctl --user -u $UNIT"
}

# ---------------------------------------------------------------- rollback
if [ "$MODE" = rollback ]; then
	[ -d "$BACKUP" ] || die "no cached payload at $BACKUP — nothing to roll back to"
	restore_backup
	log "rolled back"
	exit 0
fi

# ---------------------------------------------------------------- preflight
log "preflight"
command -v node >/dev/null || die "node not found (mise shim missing from PATH)"
command -v npm >/dev/null || die "npm not found"
command -v curl >/dev/null || die "curl not found"
systemctl --user is-enabled "$UNIT" >/dev/null 2>&1 || die "user unit $UNIT not installed"
free_gb=$(df -Pk "$ROOT" | awk 'NR==2 {printf "%d", $4/1024/1024}')
[ "$free_gb" -ge 3 ] || die "only ${free_gb}G free on $ROOT — need ~3G for a build"
echo "root: $ROOT"
echo "unit: $UNIT  url: $URL  node: $(node -v)  free: ${free_gb}G"
echo "version: $(node -p "require('./package.json').version")  rev: $(git rev-parse --short HEAD 2>/dev/null || echo no-git)"

# ---------------------------------------------------------------- verify
log "1/4 typecheck"
npm run typecheck

if [ "$SKIP_TESTS" = 1 ]; then
	log "2/4 tests skipped (--skip-tests)"
else
	log "2/4 tests"
	npm test
fi

# ---------------------------------------------------------------- backup
log "3/4 caching current payload"
if [ -d .next/standalone ]; then
	mkdir -p "$CACHE_DIR"
	rm -rf "$BACKUP"
	cp -a .next/standalone "$BACKUP"
	echo "cached -> $BACKUP ($(du -sh "$BACKUP" | cut -f1))"
else
	echo "no previous payload to cache (first deploy)"
fi

# ---------------------------------------------------------------- build
on_error() {
	local status=$?
	printf '\033[31mbuild/deploy failed (exit %s)\033[0m\n' "$status" >&2
	if restore_backup; then
		printf '\033[33mrolled back to the last good payload — fix the code and re-run\033[0m\n' >&2
	else
		printf '\033[31mno cached payload to restore — the service is down until a successful build\033[0m\n' >&2
	fi
	exit "$status"
}
trap on_error ERR

log "4/4 build"
npm run build
node scripts/build-server.mjs

# `next build` rewrites the tracked next-env.d.ts to point at .next/types
# instead of .next/dev/types, leaving the tree dirty after every deploy. It is
# generated (never hand-edited), and `next dev` regenerates it, so put it back.
git checkout -- next-env.d.ts 2>/dev/null || true

# ---------------------------------------------------------------- release
trap - ERR
log "restart + health"
restart_service
wait_healthy || die "deployed payload is unhealthy — run: bash scripts/deploy-local.sh --rollback"

log "done"
echo "LearnHarness $(node -p "require('./package.json').version") live at $URL"
echo "rollback available: bash scripts/deploy-local.sh --rollback"
