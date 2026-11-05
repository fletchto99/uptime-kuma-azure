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

trap '
    docker rm --force --volumes "$app" "$probe" "$db" >/dev/null 2>&1 || true
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
    docker run --detach --name "$app" --network "$network" --network-alias kuma \
        --mount "type=bind,source=$work,target=/certs,readonly" \
        -e UPTIME_KUMA_DB_TYPE=mariadb -e "UPTIME_KUMA_DB_HOSTNAME=$host" \
        -e UPTIME_KUMA_DB_PORT=3306 -e UPTIME_KUMA_DB_NAME=kuma \
        -e UPTIME_KUMA_DB_USERNAME=kuma -e UPTIME_KUMA_DB_PASSWORD='SyntheticDatabaseOnly42!' \
        -e UPTIME_KUMA_DB_SSL=true -e UPTIME_KUMA_DB_CA_FILE=/certs/ca.pem \
        kuma-compat >/dev/null
}

wait_for_kuma() {
    for ((i = 0; i < 90; i++)); do
        if docker exec "$app" node -e \
            'fetch("http://127.0.0.1:3001/setup-database-info").then(async r => { const d = await r.json(); process.exit(r.ok && d.runningSetup === false ? 0 : 1); }).catch(() => process.exit(1));' \
            >/dev/null 2>&1; then
            return 0
        fi
        [[ "$(docker inspect --format '{{.State.Running}}' "$app")" == true ]] || return 1
        sleep 2
    done
    return 1
}

start_kuma mysql
if ! wait_for_kuma; then
    docker logs "$app"
    echo "::error::Stock Kuma could not initialize its own schema on MySQL 8.4.9"
    exit 1
fi
echo "PASS: stock Kuma created its schema and started on MySQL 8.4.9 with TLS"
docker exec -e MYSQL_PWD='SyntheticRootOnly42!' "$db" mysql --protocol=socket -uroot -Nse \
    "SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema='kuma';"

docker run --rm --name "$probe" --network "$network" \
    --mount "type=bind,source=$work,target=/certs,readonly" \
    --mount "type=bind,source=$PWD/tests/configuration.cjs,target=/test.cjs,readonly" \
    kuma-compat node /test.cjs || tls_result=1

# Stop before starting a replacement. No overlapping Kuma processes.
docker stop --time 30 "$app" >/dev/null
docker rm --volumes "$app" >/dev/null
start_kuma wrong-name
if wait_for_kuma; then
    docker logs "$app"
    echo "::error::Stock Kuma accepted a trusted certificate for the wrong hostname"
    tls_result=1
else
    docker logs "$app" > "$work/wrong-host.log" 2>&1
    if grep -Eq 'ERR_TLS_CERT_ALTNAME_INVALID|Hostname/IP does not match' "$work/wrong-host.log"; then
        echo "PASS: stock Kuma rejected the wrong hostname"
    else
        cat "$work/wrong-host.log"
        echo "::error::Wrong-host connection failed for an unexpected reason"
        tls_result=1
    fi
fi

exit "$tls_result"
