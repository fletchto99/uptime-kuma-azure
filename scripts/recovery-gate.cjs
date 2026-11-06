"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { recoveryPair, approvedImage, REPOSITORY } = require("./update-policy.cjs");

function azure(args, label) {
    const result = spawnSync("az", [...args, "--only-show-errors", "--output", "json"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) { throw new Error(`Scoped Azure read failed: ${label}`); }
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(`Invalid Azure response: ${label}`);
    }
}

async function main() {
    assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY, "Unexpected repository");
    assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Only main may access production");
    const operation = process.env.UPDATE_OPERATION;
    assert.ok(["verify", "noop", "release"].includes(operation), "Invalid update operation");
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/commits/main`, {
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, "Unable to verify current main");
    const mainCommit = await response.json();
    assert.equal(mainCommit.sha, process.env.GITHUB_SHA, "Stale workflow; current main differs");
    if (process.env.EXPECTED_SHA) {
        assert.equal(process.env.EXPECTED_SHA, process.env.GITHUB_SHA, "Dispatched commit differs from checkout");
    }
    const { AZURE_SUBSCRIPTION_ID: subscription, AZURE_RESOURCE_GROUP: group,
        AZURE_WEBAPP_NAME: app, AZURE_MYSQL_SERVER_NAME: mysql } = process.env;
    for (const value of [subscription, group, app, mysql]) {
        assert.ok(value && /^[A-Za-z0-9._-]+$/.test(value), "Missing/invalid masked deployment identifier");
    }
    const base = `https://management.azure.com/subscriptions/${subscription}/resourceGroups/${group}/providers`;
    const get = (suffix, api, label) => azure(["rest", "--method", "get", "--url", `${base}/${suffix}?api-version=${api}`], label);
    const site = get(`Microsoft.Web/sites/${app}`, "2024-11-01", "app");
    assert.equal(site.properties.httpsOnly, true, "HTTPS-only must remain enabled");
    const plan = get(`Microsoft.Web/serverfarms/${app}-plan`, "2024-11-01", "plan");
    assert.equal(plan.sku.capacity, 1, "Exactly one worker is required");
    assert.equal(plan.sku.name, "B1", "Unexpected plan SKU");
    const slots = get(`Microsoft.Web/sites/${app}/slots`, "2024-11-01", "slots");
    assert.equal(slots.value.length, 0, "Slots are not allowed for this singleton service");
    const container = get(`Microsoft.Web/sites/${app}/sitecontainers/main`, "2024-11-01", "main container");
    const previousImage = container.properties.image;
    assert.ok(approvedImage(previousImage), "Live image must be an approved-package digest");
    const image = operation === "release" ? process.env.RELEASE_IMAGE : previousImage;
    assert.ok(approvedImage(image), "Release image must be an immutable approved-package digest");
    const server = get(`Microsoft.DBforMySQL/flexibleServers/${mysql}`, "2025-12-01-preview", "database metadata");
    const backups = get(`Microsoft.DBforMySQL/flexibleServers/${mysql}/backups`, "2024-12-30", "native database backups");
    const snapshots = get(`Microsoft.Web/sites/${app}/snapshots`, "2024-11-01", "asset snapshots");
    const recovery = recoveryPair({ server, backups, snapshots });
    const receipt = {
        ...recovery,
        previousImage,
        candidateImage: image,
        sourceCommit: process.env.GITHUB_SHA,
        operation,
    };
    // Timestamps locate the exact snapshot/PITR point using privately stored environment IDs.
    // No Azure IDs, hostnames, credentials or configuration are written to the artifact.
    fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "recovery.json"), JSON.stringify(receipt, null, 2));
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\nverified=true\n`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `Native recovery metadata verified. Asset snapshot and DB restore time: ${recovery.assetSnapshotTimeUtc}.\n\n` +
        "This is not a restore drill. Recovery remains an operator action and may create a billable database server.\n");
    console.log("Scoped OIDC reads and bounded native recovery metadata checks passed.");
}
main().catch((error) => {
    console.error(error.name === "AssertionError" ? error.message.split("\n")[0] : error.message);
    process.exitCode = 1;
});
