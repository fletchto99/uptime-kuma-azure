"use strict";
const fs = require("node:fs");
const { eligibleUpdate, REPOSITORY, WORKFLOW } = require("./update-policy.cjs");

async function api(path, method = "GET", body) {
    const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) { throw new Error(`GitHub ${method} failed with ${response.status}`); }
    return response.status === 204 ? null : response.json();
}

async function main() {
    if (process.env.ENABLE_CONTROLLED_UPDATES !== "true") {
        console.log("Automatic updates are disabled.");
        return;
    }
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const run = await api(`/repos/${REPOSITORY}/actions/runs/${event.workflow_run.id}`);
    const workflow = await api(`/repos/${REPOSITORY}/actions/workflows/compatibility.yml`);
    if (run.workflow_id !== workflow.id || run.path !== WORKFLOW || run.event !== "pull_request" ||
        run.conclusion !== "success" || run.repository?.full_name !== REPOSITORY) { return; }
    const jobs = await api(`/repos/${REPOSITORY}/actions/runs/${run.id}/jobs?per_page=100`);
    if (!jobs.jobs.some((job) => job.name === "mysql-tls" && job.conclusion === "success")) { return; }
    const main = await api(`/repos/${REPOSITORY}/commits/main`);
    for (const linked of run.pull_requests || []) {
        const pr = await api(`/repos/${REPOSITORY}/pulls/${linked.number}`);
        const files = await api(`/repos/${REPOSITORY}/pulls/${pr.number}/files?per_page=100`);
        if (pr.changed_files !== 1) { continue; }
        const readFile = async (sha) => {
            const file = await api(`/repos/${REPOSITORY}/contents/Dockerfile?ref=${sha}`);
            if (file.encoding !== "base64") { throw new Error("Unexpected Dockerfile encoding"); }
            return Buffer.from(file.content, "base64").toString("utf8");
        };
        const update = eligibleUpdate({
            pr, run, mainSha: main.sha, files,
            before: await readFile(main.sha), after: await readFile(pr.head.sha),
        });
        if (!update) { continue; }
        const release = await api(`/repos/louislam/uptime-kuma/releases/tags/${update.version}`);
        if (release.draft || release.prerelease || release.tag_name !== update.version) { continue; }
        // REST merge honors branch protection; SHA prevents merging a replaced head.
        const merged = await api(`/repos/${REPOSITORY}/pulls/${pr.number}/merge`, "PUT", {
            sha: update.headSha, merge_method: "squash",
        });
        if (!merged.merged) { throw new Error("Protected merge was not completed"); }
        // GITHUB_TOKEN merges suppress push events. workflow_dispatch is explicitly supported.
        await api(`/repos/${REPOSITORY}/actions/workflows/deploy.yml/dispatches`, "POST", {
            ref: "main", inputs: { operation: "release", expected_sha: merged.sha },
        });
        console.log(`Merged eligible ${update.updateType} update #${pr.number}; dispatched the tested main release.`);
        return;
    }
    console.log("No eligible current-head/current-base Dependabot update; nothing merged.");
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
