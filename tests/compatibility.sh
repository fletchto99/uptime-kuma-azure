#!/usr/bin/env bash
set -Eeuo pipefail

# No real data or Azure access: isolated, disposable GitHub-hosted Docker network.
[[ "${GITHUB_ACTIONS:-}" == "true" && "${RUNNER_ENVIRONMENT:-}" == "github-hosted" ]] || {
    echo "This test is restricted to GitHub-hosted synthetic CI." >&2
    exit 1
}

mysql_image="mysql:8.4.9@sha256:c36050afdca850f23cef85703f84c7531a5ae155a11b5ee1c60acb09937c4084"
kuma_image="$(awk '$1 == "FROM" { print $2 }' Dockerfile)"
[[ "$kuma_image" =~ ^louislam/uptime-kuma:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}$ ]]
work="$(mktemp -d "$RUNNER_TEMP/kuma-compat.XXXXXX")"
network="kuma-compat-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
db="$network-db"
app="$network-app"
probe="$network-probe"
source_app="$network-source"

trap '
    docker rm --force --volumes "$app" "$probe" "$db" "$source_app" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=Synthetic test CA" \
    -keyout "$work/ca.key" -out "$work/ca.pem" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=Untrusted test CA" \
    -keyout "$work/untrusted-ca.key" -out "$work/untrusted-ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=mysql" \
    -keyout "$work/server.key" -out "$work/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:mysql\nextendedKeyUsage=serverAuth\n' > "$work/server.ext"
openssl x509 -req -in "$work/server.csr" -CA "$work/ca.pem" -CAkey "$work/ca.key" \
    -CAcreateserial -days 1 -extfile "$work/server.ext" -out "$work/server.pem"
chmod 755 "$work"
chmod 644 "$work/server.key" "$work/server.pem" "$work/ca.pem" "$work/untrusted-ca.pem"

# Verify the readable tag really names this multi-platform index, not a platform manifest.
docker buildx imagetools inspect "${kuma_image%@*}" > "$work/image-index.txt"
grep -F "${kuma_image#*@}" "$work/image-index.txt"
grep -F 'linux/amd64' "$work/image-index.txt"
grep -F 'linux/arm64' "$work/image-index.txt"
docker build --pull --tag kuma-compat .
docker pull "$mysql_image"
docker network create "$network" >/dev/null
docker run --detach --name "$db" --network "$network" --network-alias mysql \
    --network-alias wrong-name --mount type=tmpfs,destination=/var/lib/mysql \
    --mount "type=bind,source=$work,target=/certs,readonly" \
    -e MYSQL_ROOT_PASSWORD='SyntheticRootOnly42!' \
    -e MYSQL_DATABASE=kuma -e MYSQL_USER=kuma -e MYSQL_PASSWORD='SyntheticDatabaseOnly42!' \
    "$mysql_image" --require-secure-transport=ON --tls-version=TLSv1.2,TLSv1.3 \
    --ssl-ca=/certs/ca.pem --ssl-cert=/certs/server.pem --ssl-key=/certs/server.key >/dev/null

ready=false
for ((i = 0; i < 90; i++)); do
    if docker exec -e MYSQL_PWD='SyntheticRootOnly42!' "$db" \
        mysql --protocol=tcp -h127.0.0.1 --ssl-mode=REQUIRED -uroot -Nse 'SELECT 1' >/dev/null 2>&1; then
        ready=true
        break
    fi
    sleep 2
done
if [[ "$ready" != true ]]; then
    docker logs "$db"
    echo "::error::Synthetic MySQL did not become ready"
    exit 1
fi

tls_result=0
docker run --rm --name "$probe" --network "$network" \
    --mount "type=bind,source=$work,target=/certs,readonly" \
    --mount "type=bind,source=$PWD/tests/mysql-tls.cjs,target=/test.cjs,readonly" \
    kuma-compat node /test.cjs || tls_result=$?

start_kuma() {
    local host="$1"
    local ca_file="${2:-ca.pem}"
    docker run --detach --name "$app" --network "$network" --network-alias kuma \
        --mount "type=bind,source=$work,target=/certs,readonly" \
        -e UPTIME_KUMA_DB_TYPE=mariadb -e "UPTIME_KUMA_DB_HOSTNAME=$host" \
        -e UPTIME_KUMA_DB_PORT=3306 -e UPTIME_KUMA_DB_NAME=kuma \
        -e UPTIME_KUMA_DB_USERNAME=kuma -e UPTIME_KUMA_DB_PASSWORD='SyntheticDatabaseOnly42!' \
        -e UPTIME_KUMA_DB_SSL=true -e "UPTIME_KUMA_DB_CA_FILE=/certs/$ca_file" \
        kuma-compat >/dev/null
}

wait_for_kuma() {
    local container="${1:-$app}"
    for ((i = 0; i < 90; i++)); do
        if docker exec "$container" node -e \
            'fetch("http://127.0.0.1:3001/healthz").then(async r => { const d = await r.json(); process.exit(r.status === 200 && d.status === "ok" ? 0 : 1); }).catch(() => process.exit(1));' \
            >/dev/null 2>&1; then
            return 0
        fi
        [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == true ]] || return 1
        sleep 2
    done
    return 1
}

docker run --detach --name "$source_app" --network "$network" --network-alias kuma-source \
    -e UPTIME_KUMA_DB_TYPE=sqlite kuma-compat >/dev/null
if ! wait_for_kuma "$source_app"; then
    docker logs "$source_app"
    exit 1
fi
docker run --rm --name "$probe" --network "$network" -e KUMA_TEST_HOST=kuma-source -e SEED_SQLITE=true \
    --mount "type=bind,source=$PWD/tests/configuration.cjs,target=/test.cjs,readonly" \
    kuma-compat node /test.cjs
docker stop --time 30 "$source_app" >/dev/null
docker cp "$source_app:/app/data/kuma.db" "$work/source.db"
python3 - "$work/source.db" <<'PY'
import sqlite3
import sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("UPDATE monitor SET id=id+100")
    db.execute("UPDATE monitor_notification SET monitor_id=monitor_id+100, notification_id=notification_id+1000")
    db.execute("UPDATE monitor_group SET monitor_id=monitor_id+100")
    db.execute("UPDATE notification SET id=id+1000")
PY
python3 scripts/export_settings.py "$work/source.db" "$work/settings.json"

start_kuma mysql
if ! wait_for_kuma; then
    docker logs "$app"
    echo "::error::Kuma could not initialize its own schema on MySQL 8.4.9"
    exit 1
fi
echo "PASS: Kuma created its schema and started on MySQL 8.4.9 with TLS"
docker exec -e MYSQL_PWD='SyntheticRootOnly42!' "$db" mysql --protocol=socket -uroot -Nse \
    "SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema='kuma';"

docker run --rm --name "$probe" --network "$network" -e CREATE_ADMIN_ONLY=true \
    --mount "type=bind,source=$PWD/tests/configuration.cjs,target=/test.cjs,readonly" \
    kuma-compat node /test.cjs
# Exercise the real private CLI against loopback, using synthetic input only.
docker run --rm --name "$probe" --network "container:$app" \
    -e KUMA_URL=http://127.0.0.1:3001 -e KUMA_USERNAME=synthetic-admin \
    -e KUMA_PASSWORD='SyntheticAdminOnly42!' -e NODE_PATH=/app/node_modules \
    --mount "type=bind,source=$work,target=/private" \
    --mount "type=bind,source=$PWD/scripts/restore-settings.cjs,target=/restore.cjs,readonly" \
    kuma-compat node /restore.cjs /private/settings.json /private/mapping.json

if ! docker run --rm --name "$probe" --network "$network" \
    -e IMPORT_MANIFEST=/certs/settings.json \
    -e VERIFY_IMPORTED_REPORT=/certs/mapping.json \
    --mount "type=bind,source=$work,target=/certs,readonly" \
    --mount "type=bind,source=$PWD/tests/configuration.cjs,target=/test.cjs,readonly" \
    --mount "type=bind,source=$PWD/scripts/restore-settings.cjs,target=/restore.cjs,readonly" \
    kuma-compat node /test.cjs; then
    docker logs "$app"
    tls_result=1
fi

docker run --rm --name "$probe" --network "$network" \
    --mount "type=bind,source=$PWD/tests/health-http.cjs,target=/test.cjs,readonly" \
    kuma-compat node /test.cjs
docker network disconnect "$network" "$db"
sleep 3
health_result=0
docker run --rm --name "$probe" --network "$network" -e EXPECTED_HEALTH_STATUS=503 \
    --mount "type=bind,source=$PWD/tests/health-http.cjs,target=/test.cjs,readonly" \
    kuma-compat node /test.cjs || health_result=$?
docker network connect --alias mysql --alias wrong-name "$network" "$db"
if ! wait_for_kuma; then
    docker logs "$app"
    echo "::error::Application/database health did not recover after synthetic connectivity restoration"
    exit 1
fi
[[ "$health_result" == 0 ]] || exit "$health_result"
echo "PASS: actual app health recovered after synthetic database disconnection"

# Stop before starting a replacement. No overlapping Kuma processes.
docker stop --time 30 "$app" >/dev/null
docker rm --volumes "$app" >/dev/null
start_kuma wrong-name
if wait_for_kuma; then
    docker logs "$app"
    echo "::error::Kuma accepted a trusted certificate for the wrong hostname"
    tls_result=1
else
    docker logs "$app" > "$work/wrong-host.log" 2>&1
    if grep -Eq 'ERR_TLS_CERT_ALTNAME_INVALID|Hostname/IP does not match' "$work/wrong-host.log"; then
        echo "PASS: actual Kuma app rejected the wrong hostname"
    else
        cat "$work/wrong-host.log"
        echo "::error::Wrong-host connection failed for an unexpected reason"
        tls_result=1
    fi
fi

docker rm --force --volumes "$app" >/dev/null
start_kuma mysql untrusted-ca.pem
if wait_for_kuma; then
    echo "::error::Kuma accepted an untrusted CA"
    tls_result=1
else
    docker logs "$app" > "$work/untrusted-ca.log" 2>&1
    if grep -Eq 'self-signed certificate in certificate chain|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT' "$work/untrusted-ca.log"; then
        echo "PASS: actual Kuma app rejected an untrusted CA"
    else
        cat "$work/untrusted-ca.log"
        echo "::error::Untrusted-CA connection failed for an unexpected reason"
        tls_result=1
    fi
fi

exit "$tls_result"
