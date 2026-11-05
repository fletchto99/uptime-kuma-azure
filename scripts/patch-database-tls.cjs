"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const targets = [
    ["server/database.js", "a155d869e9540fd34955b56634acc6ca0ef17b2a7f01c6ae8e31d5b21481bba6", 2],
    ["server/setup-database.js", "2e82d7af6870c83e7ba7917f5ca58cb615d76208587cdd1a67cc134f46b84013", 1],
];

// Verify every input before writing any file. Upstream updates require review.
const patches = targets.map(([relative, expectedHash, expectedCount]) => {
    const file = path.join("/app", relative);
    const source = fs.readFileSync(file, "utf8");
    const hash = createHash("sha256").update(source).digest("hex");
    assert.equal(hash, expectedHash, `${relative} changed upstream; review or remove the TLS patch`);
    const pattern = /^([ \t]*)rejectUnauthorized: true,$/gm;
    assert.equal([...source.matchAll(pattern)].length, expectedCount, `${relative}: unexpected SSL configuration`);
    const content = source.replace(pattern, "$1rejectUnauthorized: true,\n$1verifyIdentity: true,");
    return { file, content, expectedCount };
});

for (const { file, content, expectedCount } of patches) {
    fs.writeFileSync(file, content);
    console.log(`Enabled database TLS hostname verification at ${expectedCount} connection site(s) in ${file}`);
}
