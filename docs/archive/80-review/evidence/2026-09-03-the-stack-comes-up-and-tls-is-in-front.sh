#!/bin/sh
# WO-11 §6 G7 — the stack comes up from the compose file and the health
# endpoint answers through Caddy over TLS. Plus the two properties that make
# `49` §6's C7 argument true rather than merely intended.
#
# WHY TLS IS THE POINT HERE. C7 -- no C or C++ in the shipped closure -- survives
# ONLY because TLS terminates in front of the binary: rustls's crypto provider
# (`ring` or `aws-lc-sys`) brings C and assembly back in, and `deny.toml` bans
# all four carriers by name. That ban is only survivable if something else is
# doing TLS. This driver checks that something is, and that the server is not
# ALSO reachable without it -- because a plaintext endpoint on the network would
# work, and working is how that mistake survives.
#
# THE CERTIFICATE IS VERIFIED, NOT WAVED THROUGH. Caddy's internal CA root is
# pulled out of the container and used as the trust anchor, so this drives a
# real TLS handshake with real verification. `curl -k` would have passed against
# a server presenting nothing at all.
#
# Needs: docker with the compose plugin, curl, openssl. Run from the workspace
# root with the stack already up:
#
#   POSTGRES_PASSWORD=... FATHOM_HTTPS_PORT=18443 \
#     docker compose -f deploy/compose.yaml up -d --build

set -eu

COMPOSE="docker compose -f deploy/compose.yaml"
PORT="${FATHOM_HTTPS_PORT:-18443}"
CA=$(mktemp)

pass=0
fail=0
ok()   { pass=$((pass + 1)); echo "  ok    $1"; }
bad()  { fail=$((fail + 1)); echo "  FAIL  $1"; }
check(){ if [ "$1" = 0 ]; then ok "$2"; else bad "$2"; fi; }

trap 'rm -f "$CA"' EXIT INT TERM

echo "the-stack-comes-up-and-tls-is-in-front"

# ---- 1. every service is up ----
for svc in db server caddy; do
    state=$($COMPOSE ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1 == s { print $2 }')
    [ "$state" = "running" ]
    check $? "$svc is running (state: ${state:-absent})"
done

# ---- 2. the container's own health check, which is the BINARY ----
# 43 §5.4: distroless has no shell and no curl, so the binary probes itself.
i=0
health=""
while [ "$i" -lt 40 ]; do
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
        "$($COMPOSE ps -q server)" 2>/dev/null || true)
    [ "$health" = healthy ] && break
    i=$((i + 1)); sleep 2
done
[ "$health" = healthy ]
check $? "the container reports healthy via the binary's own healthcheck (got: ${health:-none})"

# ---- 3. Caddy's root CA, so the handshake is really verified ----
docker exec "$($COMPOSE ps -q caddy)" \
    cat /data/caddy/pki/authorities/local/root.crt > "$CA" 2>/dev/null
[ -s "$CA" ]; check $? "Caddy's internal CA root was extracted"
openssl x509 -in "$CA" -noout -subject > /dev/null 2>&1
check $? "and it is a certificate"

probe() {
    curl -s -o /tmp/.g7body -w '%{http_code}' --max-time 15 \
        --cacert "$CA" --resolve "localhost:$PORT:127.0.0.1" \
        "https://localhost:$PORT/health" 2>/dev/null
}

# ---- 4. healthy, through Caddy, over verified TLS ----
i=0; code=""
while [ "$i" -lt 20 ]; do
    code=$(probe) || code=""
    [ "$code" = 200 ] && break
    i=$((i + 1)); sleep 2
done
[ "$code" = 200 ]; check $? "GET /health through Caddy over TLS answers 200 (got ${code:-none})"
grep -q '^ok$' /tmp/.g7body; check $? "the body says ok"

# ---- 5. THE VERIFICATION IS REAL. An untrusted anchor must FAIL. ----
# Without this, case 4 would also pass against a server presenting anything at
# all, and the "over TLS" in this driver's name would be decoration.
openssl req -x509 -newkey rsa:2048 -keyout /dev/null -out /tmp/.g7-wrong-ca.pem \
    -days 1 -nodes -subj "/CN=not-caddy" > /dev/null 2>&1
if curl -s -o /dev/null --max-time 10 --cacert /tmp/.g7-wrong-ca.pem \
    --resolve "localhost:$PORT:127.0.0.1" "https://localhost:$PORT/health" 2>/dev/null; then
    bad "an unrelated CA is REJECTED (it was accepted — verification is not real)"
else
    ok "an unrelated CA is rejected, so the handshake above was really verified"
fi
rm -f /tmp/.g7-wrong-ca.pem

# ---- 6. the server is NOT reachable without TLS ----
# It is not published to the host at all. A plaintext endpoint on the network
# would work, and working is how that mistake survives.
published=$($COMPOSE ps --format '{{.Service}} {{.Ports}}' 2>/dev/null | awk '$1 == "server" { $1=""; print }')
case "$published" in
    *"->"*) bad "the server publishes a port to the host: $published" ;;
    *) ok "the server publishes no port to the host" ;;
esac
if curl -s -o /dev/null --max-time 5 "http://127.0.0.1:8080/health" 2>/dev/null; then
    bad "something answers plaintext HTTP on 8080"
else
    ok "nothing answers plaintext HTTP on the host"
fi

# ---- 7. G5 again, through the whole stack: stop the database ----
$COMPOSE stop db > /dev/null 2>&1
i=0; code=""
while [ "$i" -lt 10 ]; do
    code=$(probe) || code=""
    [ "$code" = 503 ] && break
    i=$((i + 1)); sleep 2
done
[ "$code" = 503 ]; check $? "with the database stopped, /health answers 503 through TLS (got ${code:-none})"

$COMPOSE start db > /dev/null 2>&1
i=0; code=""
while [ "$i" -lt 30 ]; do
    code=$(probe) || code=""
    [ "$code" = 200 ] && break
    i=$((i + 1)); sleep 2
done
[ "$code" = 200 ]; check $? "and 200 again when it returns (got ${code:-none})"

# ---- 8. G8, in the composed database ----
tables=$($COMPOSE exec -T db psql -U fathom -d fathom -At -c \
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1" 2>/dev/null | tr -d '\r')
[ "$tables" = "_fathom_migrations" ]
check $? "G8: the composed database holds the migrations table and nothing else (saw: ${tables:-none})"

# ---- 9. G6, in the composed server's real logs ----
logs=$($COMPOSE logs server 2>/dev/null)
case "$logs" in
    *"$POSTGRES_PASSWORD"*) bad "G6: the database password is in the container's logs" ;;
    *) ok "G6: the database password appears in none of the container's logs" ;;
esac
case "$logs" in
    *redacted*) ok "and the startup line says it was redacted" ;;
    *) bad "the startup line does not mention redaction" ;;
esac

# ---- 10. the container posture the compose file claims ----
sid=$($COMPOSE ps -q server)
ro=$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$sid")
[ "$ro" = true ]; check $? "the server's root filesystem is read-only"
caps=$(docker inspect --format '{{.HostConfig.CapDrop}}' "$sid")
case "$caps" in *ALL*) ok "all capabilities are dropped" ;; *) bad "capabilities: $caps" ;; esac
user=$(docker inspect --format '{{.Config.User}}' "$sid")
[ "$user" = "65532:65532" ]; check $? "it runs as nonroot (got: ${user:-root})"
opts=$(docker inspect --format '{{.HostConfig.SecurityOpt}}' "$sid")
case "$opts" in *no-new-privileges*) ok "no-new-privileges is set" ;; *) bad "security_opt: $opts" ;; esac

echo
echo "the-stack-comes-up-and-tls-is-in-front: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
