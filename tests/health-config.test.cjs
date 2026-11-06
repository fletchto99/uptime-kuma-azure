"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "..", "infra", "main.bicep"), "utf8");

test("health and SSH controls keep one Linux worker and conservative recycling", () => {
    assert.match(source, /healthCheckPath: '\/healthz'/);
    assert.match(source, /sshEnabled: false/);
    assert.match(source, /remoteDebuggingEnabled: false/);
    assert.match(source, /autoHealEnabled: true/);
    assert.match(source, /actionType: 'Recycle'/);
    assert.match(source, /minProcessExecutionTime: '00:30:00'/);
    assert.match(source, /statusCodes: '500-599'/);
    assert.match(source, /timeTaken: '00:00:30'/);
    assert.match(source, /WEBSITE_HEALTHCHECK_MAXPINGFAILURES', value: '5'/);
    assert.match(source, /numberOfWorkers: 1/);
    assert.ok(!source.includes("CONTAINER_AVAILABILITY_CHECK_MODE"));
    assert.ok(!source.includes("privateBytesInKB"));
});
