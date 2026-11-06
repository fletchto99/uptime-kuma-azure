"use strict";
const fs = require("node:fs");
const { REPOSITORY } = require("./update-policy.cjs");

async function api(path, method = "GET", body) {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
        method,
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) { throw new Error(`Failure notification request failed (${response.status})`); }
    return response.json();
}
async function main() {
    if (!fs.existsSync(process.env.DEPLOYMENT_FAILURE_FILE)) {
        console.log("No actual deployment failure marker; no incident issue created.");
        return;
    }
    if (process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== "refs/heads/main") {
        throw new Error("Incident reporting is restricted to trusted main deployments");
    }
    const title = "Controlled Kuma deployment needs operator recovery";
    const run = `https://github.com/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    const body = `The controlled deployment failed after attempting to stop/update/start the app.\n\n` +
        `Run: ${run}\n\nThe cleanup attempted to leave the app stopped. Inspect its actual state before retrying. ` +
        `Use the run's recovery metadata artifact and the privately stored environment identifiers. ` +
        `An image rollback alone is not a database schema rollback; restoring MySQL may create a billable server.\n\n` +
        `@fletchto99`;
    let existing;
    for (let page = 1; page <= 10; page++) {
        const issues = await api(`/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100&page=${page}`);
        existing = issues.find((issue) => !issue.pull_request && issue.title === title);
        if (existing || issues.length < 100) { break; }
        if (page === 10) { throw new Error("Too many open bot issues to safely deduplicate the incident"); }
    }
    if (existing) {
        await api(`/issues/${existing.number}`, "PATCH", { body });
        console.log(`Updated existing deployment incident #${existing.number}.`);
    } else {
        const issue = await api("/issues", "POST", { title, body });
        console.log(`Opened deployment incident #${issue.number}.`);
    }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
