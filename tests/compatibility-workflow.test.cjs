"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "compatibility.yml"), "utf8")
    .replaceAll("\r\n", "\n");

test("every push and PR, including documentation-only changes, triggers compatibility", () => {
    assert.match(workflow, /^  push: \{\}$/m);
    assert.match(workflow, /^  pull_request: \{\}$/m);
    assert.doesNotMatch(workflow, /^  pull_request_target:/m);
});

test("CI retains the exact required mysql-tls check and full unconditionally scheduled suite", () => {
    const job = workflow.match(/^  mysql-tls:\n([\s\S]*?)(?=^  publish:)/m)?.[1];
    assert.ok(job, "The required mysql-tls job must exist");
    assert.doesNotMatch(job, /^    (?:if|name|permissions|environment):/m);
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.match(job, /- name: Validate scripts\n        run: \|/);
    for (const command of [
        "npm test",
        "python3 -m unittest discover -s tests -p '*_test.py'",
        "shellcheck tests/compatibility.sh scripts/deploy.sh",
        'az bicep build --file infra/main.bicep --outfile "$RUNNER_TEMP/main.json"',
        "run: bash tests/compatibility.sh",
    ]) {
        assert.ok(job.includes(command), `The full suite must retain: ${command}`);
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
