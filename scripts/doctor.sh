#!/usr/bin/env bash
#
# Answers "is this deployment actually wired up?" in one command.
#
#   scripts/doctor.sh
#
# It exists because the alternative is six ad-hoc greps across pm2, nginx and
# ClickHouse, each of which can look fine while the thing they add up to does
# not work — a stale API serving a current console, an index switched off, a
# queue nobody drains. Every check below reads state rather than logs, prints
# what it found, and says plainly whether it is right.
#
# Nothing here changes anything. Read-only, safe to run any time.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VHOST="${FILLMARK_VHOST:-/etc/nginx/sites-available/fillmark}"
APP="${FILLMARK_PM2_APP:-fillmark-api}"
WORKER="${FILLMARK_PM2_WORKER:-fillmark-worker}"
WALLET="${1:-}"

FAILED=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
note() { printf '    %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cd "$REPO" || exit 1

# ── the repo itself ───────────────────────────────────────────────────────
head_ "Checkout"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null)"
note "$REPO on $BRANCH at $HEAD_SHA"
git diff --quiet 2>/dev/null && ok "no uncommitted changes" ||
  bad "uncommitted changes — the build may not match the branch"

# ── env ───────────────────────────────────────────────────────────────────
head_ "Configuration (.env)"
if [ -r .env ]; then
  for key in API_USE_INDEX TRACE_LOOKBACK_DAYS INDEX_REQUEST_DAYS API_TRACE_TIMEOUT_MS; do
    VAL="$(grep -E "^${key}=" .env | tail -1 | cut -d= -f2-)"
    note "$(printf '%-24s%s' "$key" "${VAL:-(unset — default)}")"
  done
  grep -qE '^API_USE_INDEX=(true|1|yes)$' .env &&
    ok "the index is switched on" ||
    bad "API_USE_INDEX is not true — nothing is queued and nothing is served from the index"
else
  bad "no .env in $REPO"
fi

# ── processes ─────────────────────────────────────────────────────────────
head_ "Processes"
for proc in "$APP" "$WORKER"; do
  if pm2 describe "$proc" 2>/dev/null | grep -q 'status.*online'; then
    ok "$proc online"
  else
    bad "$proc is not online — pm2 logs $proc --lines 50"
  fi
done

# ── is the running API the build in this checkout? ────────────────────────
head_ "Is the API running this build?"
# The question every other check depends on, and the one pm2 cannot answer:
# `pm2 restart` succeeds whether or not the build under it changed.
RUNNING_SINCE="$(pm2 jlist 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).find(x=>x.name===process.argv[1]);process.stdout.write(String(p?.pm2_env?.pm_uptime??0))}catch{process.stdout.write("0")}})' "$APP")"
BUILT_AT=0
[ -f "$REPO/apps/api/dist/main.js" ] &&
  BUILT_AT="$(( $(stat -c %Y "$REPO/apps/api/dist/main.js" 2>/dev/null || echo 0) * 1000 ))"

if [ "$BUILT_AT" -eq 0 ]; then
  bad "apps/api/dist/main.js does not exist — pnpm run build has never succeeded here"
elif [ "${RUNNING_SINCE:-0}" -eq 0 ]; then
  # Unknown is not the same as wrong, and reporting it as wrong would send
  # somebody chasing a stale build that is not stale.
  note "could not read the API's uptime from pm2 — skipping this check"
elif [ "$RUNNING_SINCE" -ge "$BUILT_AT" ]; then
  ok "the API started after the last build"
else
  bad "the API has been up since before the last build — it is serving older code"
  note "pm2 restart $APP --update-env"
fi

# ── the console the browser gets ──────────────────────────────────────────
head_ "Console"
WANT="$(grep -o 'fillmark:build" content="[a-f0-9]*"' "$REPO/dist/app/index.html" 2>/dev/null |
  head -1 | grep -o '[a-f0-9]\{6,\}')"
SERVER="$(grep -hoE '^[[:space:]]*server_name[[:space:]]+[^;]+' "$VHOST" 2>/dev/null |
  head -1 | awk '{print $2}')"
if [ -z "$WANT" ]; then
  bad "no local build to compare against — run node scripts/build-site.mjs"
elif [ -z "$SERVER" ]; then
  bad "cannot read server_name from $VHOST"
else
  GOT="$(curl -fsS "https://$SERVER/app/" 2>/dev/null |
    grep -o 'fillmark:build" content="[a-f0-9]*"' | head -1 | grep -o '[a-f0-9]\{6,\}')"
  [ "$GOT" = "$WANT" ] && ok "serving build $GOT" ||
    bad "serving build ${GOT:-<none>}, this checkout builds $WANT"
fi

# ── the store ─────────────────────────────────────────────────────────────
head_ "Index"
CH_URL="$(grep -E '^CLICKHOUSE_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
CH_DB="$(grep -E '^CLICKHOUSE_DATABASE=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
CH_USER="$(grep -E '^CLICKHOUSE_USER=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
CH_PASS="$(grep -E '^CLICKHOUSE_PASSWORD=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
CH_URL="${CH_URL:-http://localhost:8123}"
CH_DB="${CH_DB:-exitliquidity}"

ch() {
  curl -fsS "${CH_URL}/?database=${CH_DB}" \
    ${CH_USER:+-u "${CH_USER}:${CH_PASS}"} --data-binary "$1" 2>/dev/null
}

if ! ch 'SELECT 1' >/dev/null; then
  bad "ClickHouse at $CH_URL is not answering — docker ps"
else
  ok "ClickHouse answering at $CH_URL/$CH_DB"

  TABLES="$(ch "SELECT name FROM system.tables WHERE database='${CH_DB}'")"
  for table in swaps wallet_coverage wallet_index_requests; do
    grep -qx "$table" <<<"$TABLES" && ok "$table exists" ||
      bad "$table is missing — pnpm --filter @exitliquidity/ingest exec tsx src/cli.ts migrate"
  done

  if grep -qx wallet_index_requests <<<"$TABLES"; then
    QUEUED="$(ch 'SELECT count() FROM wallet_index_requests FINAL')"
    note "wallets requested: ${QUEUED:-?}"
    [ "${QUEUED:-0}" != "0" ] &&
      ch 'SELECT wallet, days, reason, requested_at FROM wallet_index_requests FINAL
          ORDER BY requested_at DESC LIMIT 5 FORMAT PrettyCompactMonoBlock' |
        sed 's/^/    /'
  fi

  if grep -qx wallet_coverage <<<"$TABLES"; then
    COVERED="$(ch 'SELECT count() FROM wallet_coverage FINAL')"
    note "wallets indexed:   ${COVERED:-?}"
    [ "${COVERED:-0}" != "0" ] &&
      ch 'SELECT wallet, from_ts, to_ts, swaps, prices_ready FROM wallet_coverage FINAL
          ORDER BY updated_at DESC LIMIT 5 FORMAT PrettyCompactMonoBlock' |
        sed 's/^/    /'
  fi

  if [ -n "$WALLET" ] && grep -qx wallet_coverage <<<"$TABLES"; then
    head_ "This wallet: $WALLET"
    ROW="$(ch "SELECT toUnixTimestamp(from_ts), toUnixTimestamp(to_ts), swaps
               FROM wallet_coverage FINAL WHERE wallet='${WALLET}'")"
    if [ -z "$ROW" ]; then
      REQ="$(ch "SELECT count() FROM wallet_index_requests FINAL WHERE wallet='${WALLET}'")"
      if [ "${REQ:-0}" != "0" ]; then
        ok "queued, not yet indexed — the worker will pick it up within a poll interval"
      else
        bad "neither indexed nor queued"
        note "Trace it once at https://${SERVER}/app/?wallet=${WALLET} — that is what queues it."
        note "If it stays unqueued after a trace, API_USE_INDEX is off or the API is stale."
      fi
    else
      ok "indexed"
      note "$ROW"
      SWAPS="$(ch "SELECT count() FROM swaps WHERE wallet='${WALLET}'")"
      note "swap rows stored: ${SWAPS:-0}"
    fi
  fi
fi

head_ "Verdict"
if [ "$FAILED" -eq 0 ]; then
  printf '  \033[32mEverything above is wired up.\033[0m\n'
else
  printf '  \033[31mSomething above is not right — the failing lines say which.\033[0m\n'
fi
exit "$FAILED"
