"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

test("the image includes the combined TLS and health patch", () => {
    const dockerfile = fs.readFileSync(require.resolve("../Dockerfile"), "utf8");
    const ignore = fs.readFileSync(require.resolve("../.dockerignore"), "utf8");
    const patch = fs.readFileSync(require.resolve("../scripts/patch-managed-hosting.cjs"), "utf8");
    assert.match(dockerfile, /COPY scripts\/patch-managed-hosting\.cjs \/tmp\/patch-managed-hosting\.cjs/);
    assert.match(dockerfile, /RUN node \/tmp\/patch-managed-hosting\.cjs && rm \/tmp\/patch-managed-hosting\.cjs/);
    assert.match(ignore, /^!scripts\/patch-managed-hosting\.cjs$/m);
    assert.match(patch, /verifyIdentity: true/);
    assert.ok(patch.includes('require("./managed-health").register(app, R, log)'));
});

test("TLS patch refuses changed upstream source before writing anything", () => {
    let writes = 0;
    const source = fs.readFileSync(require.resolve("../scripts/patch-managed-hosting.cjs"), "utf8");
    const context = {
        require(name) {
            if (name === "node:fs") {
                return {
                    readFileSync: () => "unexpected upstream source",
                    writeFileSync: () => { writes++; },
                };
            }
            return require(name);
        },
        console,
    };
    assert.throws(() => vm.runInNewContext(source, context), /changed upstream/);
    assert.equal(writes, 0);
});
