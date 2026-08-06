#!/usr/bin/env bash
#
# One command that takes this checkout to a working fillmark.xyz, and says
# which step failed if one does.
#
#   scripts/deploy.sh                 # build, publish, restart, verify
#   scripts/deploy.sh <WALLET>        # the same, then index that wallet
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
printf '   root       %s\n   server     %s\n   api        %s\n' "$ROOT" "$SERVER" "$API_URL"

step "Publishing the console"
FILLMARK_API_URL="$API_URL" node scripts/build-site.mjs >/dev/null
cp -a "$REPO/dist/." "$ROOT"/

step "Restarting the API"
pm2 restart "$APP" --update-env >/dev/null
sleep 5
curl -fsS -o /dev/null "http://127.0.0.1:8080/healthz" || fail "the API is not answering on :8080"

INDEXED=""
if [ -n "$WALLET" ]; then
  step "Indexing $WALLET (${FILLMARK_INDEX_DAYS:-365} days — the long step; Ctrl+C is safe)"
  # Migrations are idempotent, and the backfill has no request timeout behind
  # it — which is the whole reason a wallet too deep for a live trace fits here.
  #
  # Deliberately not fatal. It is the only step here measured in minutes, so it
  # is the only one anybody interrupts — and losing the verification below to a
  # Ctrl+C on an optional step leaves the operator unsure whether the deploy
  # that already finished actually worked. It writes as it goes and re-running
  # resumes, so a partial index costs nothing but time.
  if pnpm --filter @exitliquidity/ingest exec tsx src/cli.ts migrate >/dev/null &&
    pnpm --filter @exitliquidity/ingest exec tsx src/cli.ts \
      backfill "$WALLET" --days "${FILLMARK_INDEX_DAYS:-365}"; then
    INDEXED=yes
  else
    printf '\n\033[33m   indexing stopped early — the deploy above still stands.\033[0m\n'
    printf '   Re-run it whenever; it resumes rather than starting over.\n'
  fi
fi

step "Verifying what is actually live"
# The console's own contents, not its API url: the url was already right on the
# build this replaces, so it proves nothing about which build is serving.
PAGE="$(curl -fsS "https://$SERVER/app/")" || fail "https://$SERVER/app/ did not answer"
grep -q 'unpriced_history' <<<"$PAGE" || fail "the site is still serving an older console build"
grep -q "content=\"$API_URL\"" <<<"$PAGE" || fail "the live console points somewhere other than $API_URL"
printf '   console    current, pointed at %s\n' "$API_URL"

if [ -n "$INDEXED" ]; then
  node scripts/trace-check.mjs "$WALLET"
fi

printf '\n\033[32mDone.\033[0m %s\n' \
  "${WALLET:+Trace $WALLET at https://$SERVER/app/?wallet=$WALLET}"
