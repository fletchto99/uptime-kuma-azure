"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

function readGithubFile(...parts) {
    return fs.readFileSync(path.join(__dirname, "..", ".github", ...parts), "utf8")
        .replaceAll("\r\n", "\n");
}

const workflow = readGithubFile("workflows", "compatibility.yml");
const pullRequest = readGithubFile("workflows", "pull-request.yml");
const action = readGithubFile("actions", "compatibility", "action.yml");

test("PRs run once, including documentation-only changes, without a publication job", () => {
    assert.match(pullRequest, /^on:\n  pull_request: \{\}\n\npermissions:/m);
    assert.deepEqual([...pullRequest.matchAll(/^  ([\w-]+):\n    runs-on:/gm)].map((match) => match[1]), ["mysql-tls"]);
    assert.doesNotMatch(pullRequest, /publish|packages:|id-token:|secrets\.|environment:|workflow_call:|workflow_run:/);
});

test("only main pushes trigger automatic compatibility publication", () => {
    assert.match(workflow, /^on:\n  push:\n    branches: \[main\]\n  workflow_dispatch:/m);
    for (const source of [workflow, pullRequest]) {
        assert.doesNotMatch(source, /^\s+(?:paths|paths-ignore|pull_request_target):/m);
    }
    assert.doesNotMatch(workflow, /^  pull_request:/m);
    assert.doesNotMatch(pullRequest, /^  push:/m);
});

test("PR and main CI retain the same required mysql-tls check and unconditionally shared suite", () => {
    const jobs = [workflow, pullRequest].map((source) => {
        const job = source.match(/^  mysql-tls:\n((?: {4}[^\n]*\n|\n)+)/m)?.[1];
        assert.ok(job, "The required mysql-tls job must exist");
        assert.doesNotMatch(job, /^    (?:if|name|permissions|environment|uses):/m);
        assert.match(source, /^permissions:\n  contents: read$/m);
        assert.match(job, /^    runs-on: ubuntu-24.04\n    timeout-minutes: 15$/m);
        assert.match(job, /uses: actions\/checkout@[a-f0-9]{40}[^\n]*\n        with:\n          persist-credentials: false\n      - uses: \.\/\.github\/actions\/compatibility\n$/);
        return job;
    });
    assert.equal(jobs[0], jobs[1]);
});

test("the shared composite action retains every compatibility step and fails visibly", () => {
    assert.match(action, /^runs:\n  using: composite\n  steps:$/m);
    assert.equal([...action.matchAll(/^      shell: bash$/gm)].length, 4);
    assert.equal([...action.matchAll(/^      if:/gm)].length, 1);
    assert.match(action, /- name: Report failed compatibility gate\n      if: failure\(\)/);
    assert.match(action, /::error::Compatibility gate failed/);
    for (const command of [
        "bash -n tests/compatibility.sh",
        "node --check tests/mysql-tls.cjs",
        "node --check tests/configuration.cjs",
        "node --check scripts/patch-database-tls.cjs",
        "node --check scripts/restore-settings.cjs",
        "node --check scripts/recovery-gate.cjs",
        "node --check scripts/release-gate.cjs",
        "node --check scripts/deployment-failure.cjs",
        "npm ci --ignore-scripts --no-audit --no-fund",
        "npm test",
        "python3 -m unittest discover -s tests -p '*_test.py'",
        "shellcheck tests/compatibility.sh scripts/deploy.sh",
        "az bicep install --version v0.48.1",
        'az bicep build --file infra/main.bicep --outfile "$RUNNER_TEMP/main.json"',
        "run: bash tests/compatibility.sh",
    ]) {
        assert.ok(action.includes(command), `The full suite must retain: ${command}`);
    }
});

test("publication stays main-only with unchanged permissions and reusable workflow semantics", () => {
    assert.match(workflow, /^  workflow_dispatch:$/m);
    assert.match(workflow, /^  workflow_call:\n    inputs:\n      publish:\n        type: boolean\n        default: false$/m);
    assert.match(workflow, /value: \$\{\{ jobs\.publish\.outputs\.image \}\}/);
    assert.match(workflow, /^  publish:\n    needs: mysql-tls$/m);
    assert.ok(workflow.includes("if: github.ref == 'refs/heads/main' && github.repository == 'fletchto99/uptime-kuma-azure' && (github.event_name == 'push' || inputs.publish)"));
    assert.match(workflow, /permissions:\n      contents: read\n      packages: write/);
});
