#!/usr/bin/env bash
#
# One command that takes this checkout to a working fillmark.xyz, and says
# which step failed if one does.
#
#   scripts/deploy.sh                 # build, publish, migrate, restart, verify
#   scripts/deploy.sh <WALLET>        # the same, then trace that wallet
#
# It exists because doing this by hand is nine commands across three systems —
# the repo, nginx and PM2 — and every one of them has a way to look like it
# worked while leaving the site on an older build. A stale console reporting an
# old answer is indistinguishable from a broken engine, and telling those apart
# by hand cost a very long day.
#
# Nothing here deletes anything. Every step announces itself, checks its own
# result, and stops on the first thing that is not true.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WALLET="${1:-}"
VHOST="${FILLMARK_VHOST:-/etc/nginx/sites-available/fillmark}"
APP="${FILLMARK_PM2_APP:-fillmark-api}"
WORKER="${FILLMARK_PM2_WORKER:-fillmark-worker}"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

cd "$REPO"

step "Building the workspace"
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run build

step "Reading the site root and API url out of nginx"
# The vhost is the authority on both. Deriving them beats a guess: the root of
# this site is `/var/www/html`, which reads like a throwaway default and is not.
[ -r "$VHOST" ] || fail "cannot read $VHOST — set FILLMARK_VHOST to the right file"
ROOT="$(grep -hoE '^[[:space:]]*root[[:space:]]+[^;]+' "$VHOST" | head -1 | awk '{print $2}')"
[ -n "$ROOT" ] && [ -d "$ROOT" ] || fail "no usable root directive in $VHOST"
SERVER="$(grep -hoE '^[[:space:]]*server_name[[:space:]]+[^;]+' "$VHOST" | head -1 | awk '{print $2}')"
[ -n "$SERVER" ] || fail "no server_name in $VHOST"
API_URL="${FILLMARK_API_URL:-https://$SERVER/api}"
# The token's mint, when there is one. Passed through explicitly rather than
# relied on to leak from the environment, and reported either way: "coming soon"
# is a legitimate state, but it has to be a state somebody chose rather than a
# variable that was silently not set on the one deploy that mattered.
TOKEN_CA="${FILLMARK_TOKEN_CA:-}"
printf '   root       %s\n   server     %s\n   api        %s\n   $FILL CA   %s\n' \
  "$ROOT" "$SERVER" "$API_URL" "${TOKEN_CA:-not set — the page will say coming soon}"

step "Publishing the console"
FILLMARK_API_URL="$API_URL" FILLMARK_TOKEN_CA="$TOKEN_CA" node scripts/build-site.mjs >/dev/null
cp -a "$REPO/dist/." "$ROOT"/

step "Restarting the API"
pm2 restart "$APP" --update-env >/dev/null
sleep 5
curl -fsS -o /dev/null "http://127.0.0.1:8080/healthz" || fail "the API is not answering on :8080"

step "Applying migrations"
# Idempotent, and it has to happen before the API is told about a table that
# does not exist yet.
pnpm --filter @exitliquidity/ingest exec tsx src/cli.ts migrate >/dev/null ||
  fail "migrations did not apply — is ClickHouse up? (docker ps)"

step "Starting the indexer"
# The one process that makes this self-serving.
#
# The API cannot read an active wallet's year inside a web request — that is
# arithmetic, not tuning — so it writes those wallets down instead, and this
# reads them and pays for the history where nothing is waiting. Without it the
# queue fills and nobody drains it, which looks exactly like the site ignoring
# people. Started here rather than left as a note in a README, because a step
# somebody has to remember is a step that gets skipped.
if pm2 describe "$WORKER" >/dev/null 2>&1; then
  pm2 restart "$WORKER" --update-env >/dev/null
else
  pm2 start pnpm --name "$WORKER" --cwd "$REPO" -- \
    --filter @exitliquidity/ingest exec tsx src/cli.ts worker >/dev/null
fi
sleep 3
pm2 describe "$WORKER" | grep -q 'status.*online' ||
  fail "$WORKER is not staying up — pm2 logs $WORKER --lines 50"
# Survive a reboot. Without this the queue stops draining the next time the box
# restarts, and the only symptom is wallets quietly never getting faster.
pm2 save >/dev/null 2>&1 || printf '\033[33m   could not pm2 save — run it by hand\033[0m\n'
printf '   %s     online\n' "$WORKER"

step "Verifying what is actually live"
# The build id, not a feature string.
#
# The check this replaces grepped the live page for a string introduced by the
# most recent console change — which passes for every build from that change
# onwards, including the stale one it was there to catch. Twice a stale console
# passed and was mistaken for a broken engine. The id is a hash of the page
# source, so "same id" means "same bytes" and nothing else does.
WANT="$(grep -o 'fillmark:build" content="[a-f0-9]*"' "$REPO/dist/app/index.html" |
  head -1 | grep -o '[a-f0-9]\{6,\}')"
[ -n "$WANT" ] || fail "the local build carries no build id — is scripts/build-site.mjs current?"

PAGE="$(curl -fsS "https://$SERVER/app/")" || fail "https://$SERVER/app/ did not answer"
GOT="$(grep -o 'fillmark:build" content="[a-f0-9]*"' <<<"$PAGE" | head -1 | grep -o '[a-f0-9]\{6,\}')"
[ "$GOT" = "$WANT" ] ||
  fail "the site is serving build ${GOT:-<none>}, not ${WANT} — the upload to $ROOT did not take"
grep -q "content=\"$API_URL\"" <<<"$PAGE" || fail "the live console points somewhere other than $API_URL"
printf '   console    %s, pointed at %s\n' "$WANT" "$API_URL"

if [ -n "$WALLET" ]; then
  step "Tracing $WALLET"
  # The first trace of a wallet nobody has indexed is the slow one, and it is
  # supposed to be: it is what puts the wallet on the queue this deploy just
  # started draining. Run it again in a few minutes for the fast answer.
  node scripts/trace-check.mjs "$WALLET" || true
fi

printf '\n\033[32mDone.\033[0m %s\n' \
  "${WALLET:+Trace $WALLET at https://$SERVER/app/?wallet=$WALLET}"
