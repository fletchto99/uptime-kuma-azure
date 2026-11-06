"use strict";
const assert = require("node:assert/strict");

const REPOSITORY = "fletchto99/uptime-kuma-azure";
const WORKFLOW = ".github/workflows/publish.yml";
const IMAGE_PREFIX = `ghcr.io/${REPOSITORY}@sha256:`;

function eligibleMainRelease({ run, mainSha, workflowId }) {
    return /^[a-f0-9]{40}$/.test(mainSha) && Number.isSafeInteger(workflowId) && workflowId > 0 &&
        run.status === "completed" && run.conclusion === "success" && run.event === "push" &&
        run.head_branch === "main" && run.head_sha === mainSha &&
        run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY &&
        run.workflow_id === workflowId && run.path === WORKFLOW;
}

function timestamp(value) {
    assert.equal(typeof value, "string", "Missing recovery timestamp");
    // Azure snapshot timestamps omit an offset but are UTC.
    const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`;
    const result = Date.parse(normalized);
    assert.ok(Number.isFinite(result), "Invalid recovery timestamp");
    return result;
}

function recoveryPair({ server, backups, snapshots, now = Date.now() }) {
    assert.equal(server.properties.state, "Ready", "Database is not Ready");
    assert.ok(server.properties.backup.backupRetentionDays >= 7, "Database backup retention is too short");
    const earliest = timestamp(server.properties.backup.earliestRestoreDate);
    const full = backups.value.filter((item) => item.properties.backupType === "FULL")
        .map((item) => timestamp(item.properties.completedTime))
        .filter((time) => time <= now && now - time <= 26 * 3600000);
    assert.ok(full.length, "No recent completed native full backup");
    const candidates = snapshots.value.map((item) => timestamp(item.properties.time))
        .filter((time) => time >= earliest && time <= now - 15 * 60000 &&
            now - time <= 6 * 3600000 && full.some((backup) => backup <= time))
        .sort((a, b) => b - a);
    assert.ok(candidates.length, "No fresh metadata-compatible DB/assets recovery point");
    return {
        assetSnapshotTimeUtc: new Date(candidates[0]).toISOString(),
        databaseRestoreTimeUtc: new Date(candidates[0]).toISOString(),
        precedingFullBackupCompletedUtc: new Date(Math.max(...full.filter((time) => time <= candidates[0]))).toISOString(),
        verifiedAtUtc: new Date(now).toISOString(),
        assurance: "Native metadata/window checks only; not a restore drill or cross-store consistency proof",
    };
}

function approvedImage(image) {
    return typeof image === "string" && image.startsWith(IMAGE_PREFIX) &&
        /^[a-f0-9]{64}$/.test(image.slice(IMAGE_PREFIX.length));
}

module.exports = { eligibleMainRelease, recoveryPair, approvedImage, REPOSITORY, WORKFLOW };
