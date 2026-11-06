"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { eligibleMainRelease, recoveryPair, approvedImage, REPOSITORY, WORKFLOW } = require("../scripts/update-policy.cjs");
const { releaseGate } = require("../scripts/release-gate.cjs");

function release() {
    const fixture = {
        mainSha: "a".repeat(40),
        workflowId: 11,
        workflow: { id: 11, path: WORKFLOW, state: "active" },
        event: { workflow_run: { id: 7 } },
        env: {
            GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: "refs/heads/main",
            GITHUB_SHA: "a".repeat(40), GITHUB_EVENT_NAME: "workflow_run",
            ENABLE_CONTROLLED_UPDATES: "true",
        },
        run: {
            id: 7, workflow_id: 11, status: "completed", conclusion: "success",
            event: "push", path: WORKFLOW, head_sha: "a".repeat(40), head_branch: "main",
            repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
        },
        jobs: { jobs: ["mysql-tls", "publish"].map((name) => ({ name, status: "completed", conclusion: "success" })) },
        requests: [],
    };
    fixture.api = async (request) => {
        fixture.requests.push(request);
        const responses = {
            "commits/main": { sha: fixture.mainSha },
            "actions/workflows/publish.yml": fixture.workflow,
            "actions/runs/7": fixture.run,
            "actions/runs/7/jobs?per_page=100": fixture.jobs,
        };
        assert.ok(Object.hasOwn(responses, request), `Unexpected API read: ${request}`);
        return responses[request];
    };
    return fixture;
}

test("successful current-main push publication releases using read-only source-run verification", async () => {
    const fixture = release();
    assert.equal(eligibleMainRelease(fixture), true);
    assert.deepEqual(await releaseGate(fixture), { operation: "release", expectedSha: fixture.mainSha });
    assert.deepEqual(fixture.requests, [
        "commits/main", "actions/workflows/publish.yml", "actions/runs/7",
        "actions/runs/7/jobs?per_page=100",
    ]);
});

test("PR, fork, feature, failed, stale and reusable release runs never qualify", async () => {
    for (const mutate of [
        (x) => { x.run.event = "pull_request"; },
        (x) => { x.run.event = "workflow_dispatch"; },
        (x) => { x.run.event = "workflow_call"; },
        (x) => { x.run.event = "workflow_run"; },
        (x) => { x.run.head_branch = "feature"; },
        (x) => { x.run.conclusion = "failure"; },
        (x) => { x.run.conclusion = "cancelled"; },
        (x) => { x.run.status = "in_progress"; },
        (x) => { x.run.head_sha = "b".repeat(40); },
        (x) => { x.run.workflow_id = 12; },
        (x) => { x.run.path = ".github/workflows/untrusted.yml"; },
        (x) => { x.run.path = ".github/workflows/compatibility.yml"; },
        (x) => { x.run.path = ".github/workflows/test.yml"; },
        (x) => { x.run.repository.full_name = "fork/repo"; },
        (x) => { x.run.head_repository.full_name = "fork/repo"; },
    ]) {
        const fixture = release(); mutate(fixture);
        assert.equal(eligibleMainRelease(fixture), false);
        await assert.rejects(releaseGate(fixture));
    }
});

test("disabled deployments, changed main, missing publication and invalid metadata fail closed", async () => {
    for (const mutate of [
        (x) => { x.env.ENABLE_CONTROLLED_UPDATES = "false"; },
        (x) => { x.env.GITHUB_REPOSITORY = "fork/repo"; },
        (x) => { x.env.GITHUB_REF = "refs/heads/feature"; },
        (x) => { x.env.GITHUB_SHA = "bad"; },
        (x) => { x.mainSha = "b".repeat(40); },
        (x) => { x.event.workflow_run.id = "7/other"; },
        (x) => { x.workflow.state = "disabled_manually"; },
        (x) => { x.workflow.path = ".github/workflows/untrusted.yml"; },
        (x) => { x.jobs.jobs = []; },
        (x) => { x.jobs.jobs[0].conclusion = "failure"; },
        (x) => { x.jobs.jobs[1].conclusion = "skipped"; },
        (x) => { x.api = async () => { throw new Error("GitHub unavailable"); }; },
    ]) {
        const fixture = release(); mutate(fixture);
        await assert.rejects(releaseGate(fixture));
    }
});

test("manual verification/restart stay available; manual releases need activation and matching main", async () => {
    for (const operation of ["verify", "noop", "release"]) {
        const fixture = release();
        Object.assign(fixture.env, {
            GITHUB_EVENT_NAME: "workflow_dispatch", OPERATION: operation,
            EXPECTED_SHA: fixture.mainSha, ENABLE_CONTROLLED_UPDATES: operation === "release" ? "true" : "false",
        });
        assert.deepEqual(await releaseGate(fixture), { operation, expectedSha: fixture.mainSha });
        assert.deepEqual(fixture.requests, ["commits/main"]);
        fixture.env.EXPECTED_SHA = "b".repeat(40);
        await assert.rejects(releaseGate(fixture));
    }
    const disabled = release();
    Object.assign(disabled.env, { GITHUB_EVENT_NAME: "workflow_dispatch", OPERATION: "release", ENABLE_CONTROLLED_UPDATES: "false" });
    await assert.rejects(releaseGate(disabled));
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

test("only immutable package digests qualify; workflow wiring never merges or recursively releases", () => {
    assert.ok(approvedImage(`ghcr.io/${REPOSITORY}@sha256:${"a".repeat(64)}`));
    assert.ok(!approvedImage(`ghcr.io/${REPOSITORY}:latest`));
    assert.ok(!approvedImage(`ghcr.io/other/image@sha256:${"a".repeat(64)}`));
    const root = path.join(__dirname, "..");
    assert.equal(fs.existsSync(path.join(root, "scripts", "merge-dependabot.cjs")), false);
    assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "dependabot-merge.yml")), false);
    const deployment = fs.readFileSync(path.join(root, ".github", "workflows", "deploy.yml"), "utf8");
    assert.equal(WORKFLOW, ".github/workflows/publish.yml");
    assert.match(deployment, /workflow_run:\s+workflows: \["Kuma publish"\]\s+branches: \[main\]\s+types: \[completed\]/);
    assert.match(deployment, /uses: \.\/\.github\/workflows\/publish\.yml/);
    assert.match(deployment, /github\.event\.workflow_run\.event == 'push'/);
    assert.match(deployment, /github\.ref == 'refs\/heads\/main'/);
    assert.match(deployment, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(deployment, /EXPECTED_SHA: \$\{\{ needs\.gate\.outputs\.expected_sha \}\}/);
    assert.match(deployment, /actions: read/);
    for (const name of fs.readdirSync(path.join(root, ".github", "workflows"))) {
        const workflow = fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8");
        assert.doesNotMatch(workflow, /(?:contents|pull-requests|actions): write/);
    }
});

test("Dependabot checks Docker and grouped GitHub Actions weekly without changing Docker major policy", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", ".github", "dependabot.yml"), "utf8")
        .replaceAll("\r\n", "\n");
    const updates = source.split(/^  - package-ecosystem: /m).slice(1);
    assert.deepEqual(updates.map((update) => update.split("\n")[0]), ["docker", "github-actions"]);
    for (const update of updates) {
        assert.match(update, /^    directory: \/$/m);
        assert.match(update, /schedule:\n      interval: weekly\n      day: monday\n      time: "10:00"\n      timezone: "Etc\/UTC"/);
        assert.match(update, /^    open-pull-requests-limit: 3$/m);
    }
    assert.match(updates[0], /ignore:\n      - dependency-name: "\*"\n        update-types: \["version-update:semver-major"\]/);
    assert.match(updates[1], /groups:\n      github-actions:\n        patterns: \["\*"\]/);
    assert.doesNotMatch(updates[1], /^\s+(?:ignore|exclude-patterns|update-types):/m);
});
