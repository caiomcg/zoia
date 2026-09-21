#!/usr/bin/env bash
#
# Post-deployment checks. Run it ON the VM, from the deploy directory:
#
#   ssh zoia@192.168.31.60 'cd /opt/zoia && bash scripts/preflight.sh'
#
# Each check targets a failure mode that presents as an application bug and is
# not one. Exits non-zero if any hard check fails.

set -uo pipefail

PASS=0
FAIL=0
WARN=0

ok()   { echo "  [ ok ] $*"; PASS=$((PASS + 1)); }
bad()  { echo "  [FAIL] $*"; FAIL=$((FAIL + 1)); }
warn() { echo "  [warn] $*"; WARN=$((WARN + 1)); }

section() { echo; echo "== $1"; }

# ---------------------------------------------------------------------------
section "environment"

# Reads a value from .env WITHOUT sourcing it. Sourcing would execute whatever
# the file contains, and breaks outright on LIVEKIT_KEYS, whose value legitimately
# contains a colon and a space.
env_get() {
  sed -n -E "s/^[[:space:]]*$1=//p" .env 2>/dev/null \
    | tail -1 \
    | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

if [[ ! -f .env ]]; then
  bad ".env is missing — copy from scripts/gen-env.sh output"
else
  ok ".env present"
  LIVEKIT_API_KEY="$(env_get LIVEKIT_API_KEY)"
  LIVEKIT_API_SECRET="$(env_get LIVEKIT_API_SECRET)"
  LIVEKIT_KEYS="$(env_get LIVEKIT_KEYS)"
  LIVEKIT_WS_URL="$(env_get LIVEKIT_WS_URL)"
  PUBLIC_HOST="$(env_get PUBLIC_HOST)"
  TRUST_PROXY="$(env_get TRUST_PROXY)"
  SECURE_COOKIES="$(env_get SECURE_COOKIES)"

  # The classic misconfiguration: the app and the SFU disagree about the
  # credentials, which surfaces only as an opaque failure at connect time.
  expected="${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"
  if [[ "${LIVEKIT_KEYS:-}" == "$expected" ]]; then
    ok "LIVEKIT_KEYS matches LIVEKIT_API_KEY/SECRET"
  else
    bad "LIVEKIT_KEYS does not match the app's key/secret pair"
    echo "         expected: ${LIVEKIT_API_KEY}: <the api secret>"
  fi

  [[ "${LIVEKIT_WS_URL:-}" == wss://* ]] \
    && ok "LIVEKIT_WS_URL uses wss://" \
    || bad "LIVEKIT_WS_URL must start with wss:// (got '${LIVEKIT_WS_URL:-unset}')"

  [[ "${TRUST_PROXY:-0}" != "0" ]] \
    && ok "TRUST_PROXY=${TRUST_PROXY} (behind caddy)" \
    || warn "TRUST_PROXY is 0 — rate limiting will treat every user as one client"

  token="$(env_get CLOUDFLARE_API_TOKEN)"
  if [[ -z "$token" || "$token" == "PASTE_YOUR_TOKEN_HERE" || "$token" == "replace-me" ]]; then
    bad "CLOUDFLARE_API_TOKEN is not set — caddy cannot obtain certificates"
  else
    ok "CLOUDFLARE_API_TOKEN is set (${#token} chars)"
  fi

  [[ "${SECURE_COOKIES:-true}" == "true" ]] \
    && ok "SECURE_COOKIES=true" \
    || warn "SECURE_COOKIES is false — only correct for local HTTP testing"
fi

# ---------------------------------------------------------------------------
section "containers"

if ! command -v docker >/dev/null; then
  bad "docker is not installed"
else
  for svc in caddy app livekit; do
    if docker compose ps --status running --services 2>/dev/null | grep -qx "$svc"; then
      ok "$svc is running"
    else
      bad "$svc is not running (docker compose ps)"
    fi
  done
fi

# ---------------------------------------------------------------------------
section "local endpoints"

# The app publishes no host port; it is reachable only through caddy. Testing
# through caddy also exercises TLS and the proxy route, which is the path that
# actually matters.
if [[ -n "${PUBLIC_HOST:-}" ]] \
  && curl -fsS -m 10 --resolve "${PUBLIC_HOST}:443:127.0.0.1" \
       "https://${PUBLIC_HOST}/healthz" >/dev/null 2>&1; then
  ok "app answers through caddy at https://${PUBLIC_HOST}/healthz"
else
  bad "app is not answering through caddy on https://${PUBLIC_HOST:-?}/healthz"
fi

if curl -fsS -m 5 http://127.0.0.1:7880 >/dev/null 2>&1; then
  ok "livekit answers on :7880"
else
  bad "livekit is not answering on :7880"
fi

# Caddy owns the public surface; a missing 443 means nothing is reachable.
for spec in "443/tcp" "80/tcp"; do
  port="${spec%/*}"
  if ss -tln 2>/dev/null | grep -q ":${port} "; then
    ok "caddy is listening on ${port}/tcp"
  else
    bad "nothing is listening on ${port}/tcp — caddy is not up"
  fi
done

for spec in "7881/tcp" "7882/udp"; do
  port="${spec%/*}"; proto="${spec#*/}"
  flag="-tln"; [[ "$proto" == "udp" ]] && flag="-uln"
  if ss $flag 2>/dev/null | grep -q ":${port} "; then
    ok "livekit is listening on ${port}/${proto}"
  else
    bad "nothing is listening on ${port}/${proto}"
  fi
done

# ---------------------------------------------------------------------------
section "external ip discovery"

# Without use_external_ip, LiveKit advertises only private candidates and every
# remote viewer gets a permanently black video.
if grep -qE '^\s*use_external_ip:\s*true' livekit.yaml 2>/dev/null; then
  ok "use_external_ip is enabled in livekit.yaml"
else
  bad "use_external_ip is NOT enabled — remote viewers will see black video"
fi

PUBLIC_IP="$(curl -fsS -m 8 https://api.ipify.org 2>/dev/null || echo '')"
if [[ -n "$PUBLIC_IP" ]]; then
  ok "public IP is $PUBLIC_IP"
else
  warn "could not determine the public IP"
fi

if docker compose logs livekit 2>/dev/null | grep -qiE 'external ip|nodeIP'; then
  detected=$(docker compose logs livekit 2>/dev/null \
    | grep -oiE '([0-9]{1,3}\.){3}[0-9]{1,3}' | tail -1)
  if [[ -n "$detected" && -n "$PUBLIC_IP" && "$detected" == "$PUBLIC_IP" ]]; then
    ok "livekit is advertising the public IP ($detected)"
  elif [[ -n "$detected" ]]; then
    warn "livekit reports $detected, public IP is ${PUBLIC_IP:-unknown}"
  fi
fi

# ---------------------------------------------------------------------------
section "dns"

cf_range() {
  # Cloudflare's proxy ranges, abbreviated to the common ones. IPv6 matters too:
  # an AAAA record left orange-clouded fails exactly the same way.
  [[ "$1" =~ ^104\.(1[6-9]|2[0-9]|3[01])\. ]] && return 0
  [[ "$1" =~ ^172\.6[4-9]\.|^172\.7[0-1]\. ]] && return 0
  [[ "$1" =~ ^162\.15[89]\.|^188\.114\.|^198\.41\.|^141\.101\. ]] && return 0
  [[ "$1" =~ ^103\.2[12]\.|^108\.162\.|^190\.93\.|^197\.234\.|^131\.0\.72\. ]] && return 0
  [[ "$1" =~ ^2606:4700:|^2803:f800:|^2405:b500:|^2405:8100:|^2a06:98c0:|^2c0f:f248: ]] && return 0
  return 1
}

check_host() {
  local host="$1" label="$2"
  [[ -z "$host" ]] && return
  # ahostsv4 so the A record is checked, not whichever family resolves first.
  local resolved v6
  resolved="$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | head -1)"
  v6="$(getent ahostsv6 "$host" 2>/dev/null | awk '{print $1}' | head -1)"

  if [[ -n "$v6" ]] && cf_range "$v6"; then
    bad "$label has an AAAA record on Cloudflare's proxy ($v6)"
    echo "         Set it to DNS only (grey cloud), or remove the AAAA record."
  fi

  if [[ -z "$resolved" ]]; then
    bad "$label ($host) does not resolve"
  elif cf_range "$resolved"; then
    bad "$label resolves to $resolved — that is a Cloudflare PROXY address."
    echo "         Set the record to DNS only (grey cloud); the proxy will not carry WebRTC."
  elif [[ -n "$PUBLIC_IP" && "$resolved" != "$PUBLIC_IP" ]]; then
    warn "$label resolves to $resolved but the public IP is $PUBLIC_IP"
  else
    ok "$label ($host) resolves to $resolved"
  fi
}

check_host "${PUBLIC_HOST:-}" "app host"
check_host "$(echo "${LIVEKIT_WS_URL:-}" | sed -E 's#^wss?://##; s#/.*##')" "sfu host"

# ---------------------------------------------------------------------------
section "summary"
echo "  $PASS passed, $WARN warnings, $FAIL failures"
echo
if (( FAIL > 0 )); then
  echo "Fix the failures above, then re-run. docs/RUNBOOK.md has the causes."
  exit 1
fi
echo "Preflight clean. Remaining checks need a browser:"
echo "  - open the app from cellular (proves the port forwards)"
echo "  - open it from a LAN machine  (proves router hairpin)"
echo "  - chrome://webrtc-internals: the selected pair should be UDP, not TCP 7881"
