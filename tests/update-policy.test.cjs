"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { eligibleUpdate, recoveryPair, approvedImage, REPOSITORY, WORKFLOW } = require("../scripts/update-policy.cjs");

function update() {
    return {
        mainSha: "base",
        pr: {
            number: 7, state: "open", draft: false, mergeable_state: "clean",
            user: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
            base: { ref: "main", sha: "base", repo: { full_name: REPOSITORY } },
            head: { ref: "dependabot/docker/louislam/uptime-kuma-2.5.10", sha: "head", repo: { full_name: REPOSITORY } },
        },
        run: {
            conclusion: "success", event: "pull_request", path: WORKFLOW, head_sha: "head",
            repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
            pull_requests: [{ number: 7, head: { sha: "head" }, base: { sha: "base" } }],
        },
        files: [{ filename: "Dockerfile", status: "modified" }],
        before: `FROM louislam/uptime-kuma:2.5.9@sha256:${"a".repeat(64)}\nCOPY patch /patch\n`,
        after: `FROM louislam/uptime-kuma:2.5.10@sha256:${"b".repeat(64)}\nCOPY patch /patch\n`,
    };
}

test("only exact patch/minor/digest changes from current trusted Dependabot CI qualify", () => {
    assert.equal(eligibleUpdate(update()).updateType, "patch");
    const minor = update(); minor.after = minor.after.replace("2.5.10", "2.6.0");
    assert.equal(eligibleUpdate(minor).updateType, "minor");
    const digest = update(); digest.after = digest.after.replace("2.5.10", "2.5.9");
    assert.equal(eligibleUpdate(digest).updateType, "digest");
});

test("forged actors, stale commits/bases, major versions, forks and extra changes never qualify", () => {
    const cases = [
        (x) => { x.pr.user.id = 1; },
        (x) => { x.pr.user.type = "User"; },
        (x) => { x.pr.user.login = "someone"; },
        (x) => { x.pr.state = "closed"; },
        (x) => { x.pr.draft = true; },
        (x) => { x.pr.mergeable_state = "behind"; },
        (x) => { x.pr.head.repo.full_name = "fork/repo"; },
        (x) => { x.pr.head.ref = "user-branch"; },
        (x) => { x.pr.base.ref = "other"; },
        (x) => { x.mainSha = "new-main"; },
        (x) => { x.run.head_sha = "old-head"; },
        (x) => { x.run.pull_requests[0].base.sha = "old-base"; },
        (x) => { x.run.pull_requests = []; },
        (x) => { x.run.conclusion = "failure"; },
        (x) => { x.run.event = "push"; },
        (x) => { x.run.path = ".github/workflows/untrusted.yml"; },
        (x) => { x.run.head_repository.full_name = "fork/repo"; },
        (x) => { x.files.push({ filename: ".github/workflows/deploy.yml", status: "modified" }); },
        (x) => { x.files[0].status = "renamed"; },
        (x) => { x.after = x.after.replace("2.5.10", "3.0.0"); },
        (x) => { x.after = x.after.replace("2.5.10", "2.5.8"); },
        (x) => { x.after = x.after.replace("COPY patch /patch", "RUN malicious"); },
        (x) => { x.after = x.after.replace("louislam/uptime-kuma", "untrusted/image"); },
        (x) => { x.after = x.before; },
    ];
    for (const mutate of cases) {
        const fixture = update();
        mutate(fixture);
        assert.equal(eligibleUpdate(fixture), null);
    }
});

function backups() {
    return {
        now: Date.parse("2026-11-06T12:00:00Z"),
        server: { properties: { state: "Ready", backup: { backupRetentionDays: 7, earliestRestoreDate: "2026-11-05T00:00:00Z" } } },
        backups: { value: [{ properties: { backupType: "FULL", completedTime: "2026-11-06T08:00:00Z" } }] },
        snapshots: { value: [
            { properties: { time: "2026-11-06T11:00:00.1234567" } },
            { properties: { time: "2026-11-06T11:55:00Z" } },
        ] },
    };
}

test("recovery gate selects recent UTC metadata-compatible references, not a too-new snapshot", () => {
    const result = recoveryPair(backups());
    assert.equal(result.assetSnapshotTimeUtc, "2026-11-06T11:00:00.123Z");
    assert.equal(result.databaseRestoreTimeUtc, result.assetSnapshotTimeUtc);
    assert.match(result.assurance, /not a restore drill/);
    assert.deepEqual(Object.keys(result).sort(), [
        "assetSnapshotTimeUtc", "databaseRestoreTimeUtc", "precedingFullBackupCompletedUtc", "verifiedAtUtc", "assurance",
    ].sort());
});

test("missing, stale, future or out-of-window backup evidence fails closed", () => {
    for (const mutate of [
        (x) => { x.server.properties.state = "Stopped"; },
        (x) => { x.server.properties.backup.backupRetentionDays = 1; },
        (x) => { x.server.properties.backup.earliestRestoreDate = "2026-11-06T11:30:00Z"; },
        (x) => { x.backups.value = []; },
        (x) => { x.snapshots.value = []; },
        (x) => { x.backups.value[0].properties.completedTime = "2026-11-04T00:00:00Z"; },
        (x) => { x.backups.value[0].properties.completedTime = "2026-11-06T13:00:00Z"; },
        (x) => { x.snapshots.value = [{ properties: { time: "2026-11-06T05:59:00Z" } }]; },
        (x) => { x.snapshots.value = [{ properties: { time: "not-a-date" } }]; },
        (x) => { x.snapshots.value = [{ properties: { time: "2026-11-06T11:55:00Z" } }]; },
    ]) {
        const value = backups(); mutate(value);
        assert.throws(() => recoveryPair(value));
    }
});

test("only immutable package digests qualify and token merges explicitly dispatch a release", () => {
    assert.ok(approvedImage(`ghcr.io/${REPOSITORY}@sha256:${"a".repeat(64)}`));
    assert.ok(!approvedImage(`ghcr.io/${REPOSITORY}:latest`));
    assert.ok(!approvedImage(`ghcr.io/other/image@sha256:${"a".repeat(64)}`));
    const merger = fs.readFileSync(path.join(__dirname, "..", "scripts", "merge-dependabot.cjs"), "utf8");
    assert.match(merger, /actions\/workflows\/deploy\.yml\/dispatches/);
    assert.match(merger, /expected_sha: merged\.sha/);
    assert.match(merger, /sha: update\.headSha/);
});
