"use strict";
const assert = require("node:assert/strict");
const expected = Number(process.env.EXPECTED_HEALTH_STATUS || 200);

async function main() {
    const start = Date.now();
    const results = await Promise.all(Array.from({ length: 40 }, async () => {
        const response = await fetch("http://kuma:3001/healthz", { signal: AbortSignal.timeout(5000), redirect: "error" });
        assert.equal(response.status, expected);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = await response.text();
        assert.ok(body.length < 100);
        assert.deepEqual(JSON.parse(body), { status: expected === 200 ? "ok" : "unavailable" });
        return response.status;
    }));
    assert.ok(Date.now() - start < 6000, "Concurrent health responses exceeded the bounded budget");
    console.log(`PASS: 40 concurrent actual-app health requests returned minimal direct ${results[0]} responses`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
