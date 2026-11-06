"use strict";
const assert = require("node:assert/strict");

const REPOSITORY = "fletchto99/uptime-kuma-azure";
const WORKFLOW = ".github/workflows/compatibility.yml";
const IMAGE_PREFIX = `ghcr.io/${REPOSITORY}@sha256:`;

function eligibleUpdate({ pr, run, mainSha, files, before, after }) {
    if (pr.state !== "open" || pr.draft || pr.user?.login !== "dependabot[bot]" ||
        pr.user?.id !== 49699333 || pr.user?.type !== "Bot") { return null; }
    if (pr.base?.ref !== "main" || pr.base.repo?.full_name !== REPOSITORY ||
        pr.head.repo?.full_name !== REPOSITORY || !pr.head.ref.startsWith("dependabot/docker/") ||
        pr.base.sha !== mainSha || pr.mergeable_state !== "clean") { return null; }
    if (run.conclusion !== "success" || run.event !== "pull_request" ||
        run.repository?.full_name !== REPOSITORY || run.head_repository?.full_name !== REPOSITORY ||
        run.head_sha !== pr.head.sha || run.path !== WORKFLOW) { return null; }
    const tested = run.pull_requests?.find((item) => item.number === pr.number);
    if (!tested || tested.head.sha !== pr.head.sha || tested.base.sha !== mainSha) { return null; }
    if (files.length !== 1 || files[0].filename !== "Dockerfile" || files[0].status !== "modified") { return null; }
    const oldLines = before.split("\n");
    const newLines = after.split("\n");
    if (oldLines.length !== newLines.length || oldLines.slice(1).join("\n") !== newLines.slice(1).join("\n")) { return null; }
    const pattern = /^FROM louislam\/uptime-kuma:(\d+)\.(\d+)\.(\d+)@sha256:([a-f0-9]{64})$/;
    const oldPin = oldLines[0].match(pattern);
    const newPin = newLines[0].match(pattern);
    if (!oldPin || !newPin || oldPin[1] !== newPin[1] || oldLines[0] === newLines[0]) { return null; }
    const [oldMinor, oldPatch, newMinor, newPatch] = [oldPin[2], oldPin[3], newPin[2], newPin[3]].map(Number);
    if (newMinor < oldMinor || (newMinor === oldMinor && newPatch < oldPatch)) { return null; }
    return {
        version: newPin.slice(1, 4).join("."),
        updateType: newMinor > oldMinor ? "minor" : newPatch > oldPatch ? "patch" : "digest",
        headSha: pr.head.sha,
    };
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

module.exports = { eligibleUpdate, recoveryPair, approvedImage, REPOSITORY, WORKFLOW };
