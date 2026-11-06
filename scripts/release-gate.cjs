"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { eligibleMainRelease, REPOSITORY, WORKFLOW } = require("./update-policy.cjs");

async function releaseGate({ env, event, api }) {
    assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, "Unexpected repository");
    assert.equal(env.GITHUB_REF, "refs/heads/main", "Only main may release");
    assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/, "Invalid checkout SHA");
    const main = await api("commits/main");
    assert.equal(main.sha, env.GITHUB_SHA, "Stale workflow; current main differs");
    let operation;
    if (env.GITHUB_EVENT_NAME === "workflow_run") {
        const id = event.workflow_run?.id;
        assert.ok(Number.isSafeInteger(id) && id > 0, "Invalid source run");
        const workflow = await api("actions/workflows/compatibility.yml");
        assert.equal(workflow.path, WORKFLOW, "Unexpected compatibility workflow");
        assert.equal(workflow.state, "active", "Compatibility workflow is disabled");
        const run = await api(`actions/runs/${id}`);
        assert.ok(eligibleMainRelease({ run, mainSha: main.sha, workflowId: workflow.id }),
            "Only successful current-main push compatibility may release");
        const jobs = await api(`actions/runs/${id}/jobs?per_page=100`);
        for (const name of ["mysql-tls", "publish"]) {
            assert.ok(jobs.jobs.some((job) => job.name === name && job.status === "completed" && job.conclusion === "success"),
                `Successful ${name} job required`);
        }
        operation = "release";
    } else {
        assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Unsupported trigger");
        operation = env.OPERATION;
        assert.ok(["verify", "noop", "release"].includes(operation), "Invalid operation");
        if (env.EXPECTED_SHA) {
            assert.equal(env.EXPECTED_SHA, main.sha, "Dispatched commit differs from checkout");
        }
    }
    if (operation === "release") {
        assert.equal(env.ENABLE_CONTROLLED_UPDATES, "true", "Automatic deployment policy is disabled");
    }
    return { operation, expectedSha: main.sha };
}

async function main() {
    const api = async (path) => {
        const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
            headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(30000),
        });
        assert.ok(response.ok, `GitHub release gate read failed (${response.status})`);
        return response.json();
    };
    const result = await releaseGate({
        env: process.env,
        event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
        api,
    });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `operation=${result.operation}\nexpected_sha=${result.expectedSha}\n`);
    console.log(`Current-main ${result.operation} gate passed; this workflow never merges pull requests.`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.name === "AssertionError" ? error.message.split("\n")[0] : error.message);
        process.exitCode = 1;
    });
}
module.exports = { releaseGate };
