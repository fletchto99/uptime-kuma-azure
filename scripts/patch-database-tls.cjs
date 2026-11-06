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

const serverFile = "/app/server/server.js";
const serverSource = fs.readFileSync(serverFile, "utf8");
assert.equal(createHash("sha256").update(serverSource).digest("hex"),
    "2122c0a3220132385c2aa72ecf496b68ce022a5ce65bca40e2a110159612b08c",
    "server/server.js changed upstream; review the health route insertion");
const marker = "    // Robots.txt\n";
assert.equal(serverSource.split(marker).length - 1, 1, "Unexpected health route insertion point");
patches.push({
    file: serverFile,
    content: serverSource.replace(marker, '    require("./managed-health").register(app, R, log);\n\n' + marker),
    expectedCount: 1,
});

for (const { file, content, expectedCount } of patches) {
    fs.writeFileSync(file, content);
    console.log(`Applied ${expectedCount} source-checked managed-hosting change(s) in ${file}`);
}
