#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${DEPLOYMENT_APPROVED:-}" == true && "${BACKUPS_VERIFIED:-}" == true ]] || {
    echo "Deployment and matching private DB/asset backups must be explicitly approved." >&2
    exit 1
}
: "${AZURE_RESOURCE_GROUP:?Missing resource group}"
: "${AZURE_WEBAPP_NAME:?Missing app name}"
: "${AZURE_SUBSCRIPTION_ID:?Missing subscription}"
: "${IMAGE:?Missing immutable image}"
[[ "$IMAGE" =~ ^ghcr\.io/fletchto99/uptime-kuma-azure@sha256:[0-9a-f]{64}$ ]] || {
    echo "Only an approved immutable image from this package is accepted." >&2
    exit 1
}

site_url="https://management.azure.com/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$AZURE_RESOURCE_GROUP/providers/Microsoft.Web/sites/$AZURE_WEBAPP_NAME"
api="2024-11-01"
request_body="$(mktemp)"
azure_error="$(mktemp)"
trap 'rm -f -- "$request_body" "$azure_error"' EXIT
azure_rest() {
    local label="$1"
    shift
    # CLI convenience commands can fetch publishing credentials; use exact ARM operations.
    if az rest "$@" --only-show-errors 2>"$azure_error"; then
        return 0
    else
        local code=$?
        echo "::error::Azure operation failed: $label. Inspect Azure Activity Log privately." >&2
        return "$code"
    fi
}
stopping=false
trap '
    if [[ "$stopping" == true ]]; then
        if [[ -n "${DEPLOYMENT_FAILURE_FILE:-}" ]]; then
            printf "{\"deploymentStarted\":true}\n" > "$DEPLOYMENT_FAILURE_FILE"
        fi
        azure_rest "failure cleanup stop" --method post --url "$site_url/stop?api-version=$api" --output none || echo "::error::Failed to stop app; operator intervention required."
        echo "::error::Deployment failed. App is left stopped when possible; inspect privately and restore matching DB/assets if needed."
    else
        echo "::error::Deployment preflight failed; no app mutation attempted."
    fi
    exit 1
' ERR INT TERM

if [[ "${REQUIRE_CURRENT_MAIN:-}" == true ]]; then
    [[ "${GITHUB_REF:-}" == refs/heads/main && "${GITHUB_REPOSITORY:-}" == fletchto99/uptime-kuma-azure ]]
    current_main="$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)"
    [[ "$current_main" == "$GITHUB_SHA" ]] || {
        echo "::error::Main moved after recovery checks; no app change attempted."
        exit 1
    }
fi

plan_id="$(azure_rest "app read" --method get --url "$site_url?api-version=$api" --query properties.serverFarmId --output tsv)"
workers="$(azure_rest "plan read" --method get --url "https://management.azure.com$plan_id?api-version=$api" --query sku.capacity --output tsv)"
[[ "$workers" == 1 ]] || { echo "Refusing deployment: plan must have exactly one worker." >&2; exit 1; }
slots="$(azure_rest "slot read" --method get --url "$site_url/slots?api-version=$api" --query 'length(value)' --output tsv)"
[[ "$slots" == 0 ]] || { echo "Refusing deployment: slots could run duplicate monitors." >&2; exit 1; }
hostname="$(azure_rest "hostname read" --method get --url "$site_url?api-version=$api" --query properties.defaultHostName --output tsv)"
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    echo "::add-mask::$hostname"
    echo "::add-mask::$plan_id"
fi
azure_rest "container read" --method get --url "$site_url/sitecontainers/main?api-version=$api" --output json \
    | node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(0,"utf8")); if(!c.properties || c.properties.isMain!==true) process.exit(1); c.properties.image=process.env.IMAGE; process.stdout.write(JSON.stringify({properties:c.properties}));' \
    > "$request_body"

stopping=true
azure_rest "stop" --method post --url "$site_url/stop?api-version=$api" --output none
stopped=false
for ((i = 0; i < 30; i++)); do
    state="$(azure_rest "stopped state read" --method get --url "$site_url?api-version=$api" --query properties.state --output tsv)"
    if [[ "$state" == Stopped ]]; then
        stopped=true
        break
    fi
    sleep 2
done
[[ "$stopped" == true ]] || { echo "Stop did not complete; refusing to change the image." >&2; false; }
azure_rest "image update" --method put --url "$site_url/sitecontainers/main?api-version=$api" --body "@$request_body" --output none
azure_rest "start" --method post --url "$site_url/start?api-version=$api" --output none
healthy=false
for ((i = 0; i < 60; i++)); do
    if body="$(curl --fail --silent --show-error --max-time 5 "https://$hostname/healthz" 2>/dev/null)" \
        && node -e 'const d=JSON.parse(process.argv[1]); process.exit(d.status === "ok" ? 0 : 1)' "$body" 2>/dev/null; then
        healthy=true
        break
    fi
    sleep 5
done
[[ "$healthy" == true ]] || { echo "Readiness check failed." >&2; false; }
state="$(azure_rest "running state read" --method get --url "$site_url?api-version=$api" --query properties.state --output tsv)"
[[ "$state" == Running ]]
stopping=false
echo "Deployment healthy; one configured worker, no slots, stop-before-start completed."
