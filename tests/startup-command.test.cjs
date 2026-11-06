"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("App Service whitespace-split startup sets umask before loading the server", () => {
    const bicep = fs.readFileSync(path.join(__dirname, "..", "infra", "main.bicep"), "utf8");
    const match = bicep.match(/startUpCommand: '([^'\r\n]+)'/);
    assert.ok(match, "Missing startup command");
    const [executable, ...args] = match[1].split(/\s+/);
    assert.equal(executable, "node");
    assert.deepEqual(args, ["-e", "process.umask(0o077);require(process.argv[1])", "./server/server.js"]);
    assert.ok(!match[1].includes('"'), "The platform must not need shell quote parsing");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-startup-test-"));
    try {
        fs.mkdirSync(path.join(directory, "server"));
        const preload = path.join(directory, "record-umask.cjs");
        fs.writeFileSync(preload,
            "const original=process.umask.bind(process);process.umask=(value)=>{if(value!==undefined){global.requestedUmask=value;return original(value);}return original();};\n");
        fs.writeFileSync(path.join(directory, "server", "server.js"),
            'process.stdout.write(JSON.stringify({requestedMask:global.requestedUmask,mask:process.umask(),argv:process.argv.slice(1)}));\n');
        const result = spawnSync(process.execPath, ["--require", preload, ...args], { cwd: directory, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        const observed = JSON.parse(result.stdout);
        assert.equal(observed.requestedMask, 0o077);
        assert.deepEqual(observed.argv, ["./server/server.js"]);
        // Windows does not implement POSIX file-creation masks.
        if (process.platform !== "win32") {
            assert.equal(observed.mask, 0o077);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
