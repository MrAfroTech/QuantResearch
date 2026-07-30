#!/usr/bin/env bash
# Set Tastytrade sandbox/live vars on Railway from local .env (no values printed).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RAILWAY="${ROOT}/node_modules/.bin/railway"
ENV_FILE="${ROOT}/.env"

if [[ ! -x "$RAILWAY" ]]; then
  echo "Railway CLI not found. Run: npm install --no-save @railway/cli" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env at $ENV_FILE" >&2
  exit 1
fi

if ! "$RAILWAY" whoami >/dev/null 2>&1; then
  echo "Railway CLI not authenticated. Run: ./node_modules/.bin/railway login" >&2
  exit 1
fi

echo "=== Railway target ==="
"$RAILWAY" status

get_env() {
  local key="$1"
  local line val
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)"
  [[ -z "$line" ]] && return 1
  val="${line#*=}"
  [[ -z "${val// }" ]] && return 1
  printf '%s' "$val"
}

set_var() {
  local key="$1"
  local val="$2"
  printf '%s' "$val" | "$RAILWAY" variable set "$key" --stdin --skip-deploys >/dev/null
  echo "SET: $key"
}

SKIPPED=()
TO_SET=()

# Sandbox — all four required
for key in \
  TASTYTRADE_SANDBOX_CLIENT_ID \
  TASTYTRADE_SANDBOX_CLIENT_SECRET \
  TASTYTRADE_SANDBOX_REFRESH_TOKEN \
  TASTYTRADE_ACCOUNT_NUMBER; do
  if val="$(get_env "$key")"; then
    TO_SET+=("$key")
    set_var "$key" "$val"
  else
    SKIPPED+=("$key (missing or empty in .env)")
  fi
done

# Live — only if present in .env
for key in \
  TASTYTRADE_LIVE_CLIENT_ID \
  TASTYTRADE_LIVE_CLIENT_SECRET \
  TASTYTRADE_LIVE_ACCOUNT_NUMBER \
  TASTYTRADE_LIVE_REFRESH_TOKEN; do
  if val="$(get_env "$key")"; then
    TO_SET+=("$key")
    set_var "$key" "$val"
  else
    SKIPPED+=("$key (not in .env — skipped)")
  fi
done

# Explicit skip note for live refresh token
if ! grep -qE '^TASTYTRADE_LIVE_REFRESH_TOKEN=.+' "$ENV_FILE" 2>/dev/null; then
  SKIPPED+=("TASTYTRADE_LIVE_REFRESH_TOKEN (intentionally unset — pending 2FA reset)")
fi

echo ""
echo "=== Keys now present on Railway (names only) ==="
"$RAILWAY" variable list --json 2>/dev/null | node -e "
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const keys = new Set([
    'TASTYTRADE_SANDBOX_CLIENT_ID',
    'TASTYTRADE_SANDBOX_CLIENT_SECRET',
    'TASTYTRADE_SANDBOX_REFRESH_TOKEN',
    'TASTYTRADE_ACCOUNT_NUMBER',
    'TASTYTRADE_LIVE_CLIENT_ID',
    'TASTYTRADE_LIVE_CLIENT_SECRET',
    'TASTYTRADE_LIVE_ACCOUNT_NUMBER',
    'TASTYTRADE_LIVE_REFRESH_TOKEN',
  ]);
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { process.exit(0); }
  const items = Array.isArray(data) ? data : (data?.variables || []);
  for (const item of items) {
    const name = item?.name || item?.key;
    if (name && keys.has(name)) console.log(name);
  }
});
"

echo ""
echo "=== Skipped ==="
for s in "${SKIPPED[@]}"; do echo "SKIP: $s"; done

echo ""
echo "No redeploy triggered (--skip-deploys used for all sets)."
