#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${DEPLOYMENT_APPROVED:-}" == true && "${BACKUPS_VERIFIED:-}" == true ]] || {
    echo "Deployment and matching private DB/asset backups must be explicitly approved." >&2
    exit 1
}
: "${AZURE_RESOURCE_GROUP:?Missing resource group}"
: "${AZURE_WEBAPP_NAME:?Missing app name}"
: "${IMAGE:?Missing immutable image}"
[[ "$IMAGE" =~ ^ghcr\.io/fletchto99/uptime-kuma-azure@sha256:[0-9a-f]{64}$ ]] || {
    echo "Only an approved immutable image from this package is accepted." >&2
    exit 1
}

app=(--resource-group "$AZURE_RESOURCE_GROUP" --name "$AZURE_WEBAPP_NAME" --only-show-errors)
stopping=false
trap '
    if [[ "$stopping" == true ]]; then
        az webapp stop "${app[@]}" --output none || echo "::error::Failed to stop app; operator intervention required."
    fi
    echo "::error::Deployment failed. App is left stopped when possible; inspect privately and restore matching DB/assets if needed."
    exit 1
' ERR INT TERM

plan_id="$(az webapp show "${app[@]}" --query serverFarmId --output tsv)"
workers="$(az appservice plan show --ids "$plan_id" --query sku.capacity --output tsv --only-show-errors)"
[[ "$workers" == 1 ]] || { echo "Refusing deployment: plan must have exactly one worker." >&2; exit 1; }
slots="$(az webapp deployment slot list "${app[@]}" --query 'length(@)' --output tsv)"
[[ "$slots" == 0 ]] || { echo "Refusing deployment: slots could run duplicate monitors." >&2; exit 1; }
hostname="$(az webapp show "${app[@]}" --query defaultHostName --output tsv)"
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    echo "::add-mask::$hostname"
    echo "::add-mask::$plan_id"
fi

stopping=true
az webapp stop "${app[@]}" --output none
stopped=false
for ((i = 0; i < 30; i++)); do
    state="$(az webapp show "${app[@]}" --query state --output tsv)"
    if [[ "$state" == Stopped ]]; then
        stopped=true
        break
    fi
    sleep 2
done
[[ "$stopped" == true ]] || { echo "Stop did not complete; refusing to change the image." >&2; false; }
az webapp sitecontainers update "${app[@]}" --container-name main --image "$IMAGE" --output none
az webapp start "${app[@]}" --output none
healthy=false
for ((i = 0; i < 60; i++)); do
    # This route exists only after Kuma's DB initialization, not on its DB setup server.
    if body="$(curl --fail --silent --show-error --max-time 5 "https://$hostname/setup-database-info" 2>/dev/null)" \
        && node -e 'const d=JSON.parse(process.argv[1]); process.exit(d.runningSetup === false && d.needSetup === false ? 0 : 1)' "$body" 2>/dev/null; then
        healthy=true
        break
    fi
    sleep 5
done
[[ "$healthy" == true ]] || { echo "Readiness check failed." >&2; false; }
state="$(az webapp show "${app[@]}" --query state --output tsv)"
[[ "$state" == Running ]]
stopping=false
echo "Deployment healthy; one configured worker, no slots, stop-before-start completed."
