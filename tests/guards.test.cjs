"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { validate, initializeTimezone } = require("../scripts/restore-settings.cjs");

function fixture() {
    return {
        format: 1,
        manualSettingsReviewed: true,
        settings: {},
        notifications: [{ oldId: 7 }],
        monitors: Array.from({ length: 6 }, (_, id) => ({
            oldId: id,
            config: { type: "http", notificationIDList: { 7: true }, accepted_statuscodes: ["200-299"] },
        })),
        statusPage: { groups: [{ monitorList: Array.from({ length: 6 }, (_, id) => ({ id })) }] },
    };
}

test("configuration validation is fail-closed before API writes", () => {
    validate(fixture());
    for (const mutate of [
        (data) => { data.monitors[0].config.type = "docker"; },
        (data) => { data.monitors[0].config.proxy_id = 1; },
        (data) => { data.monitors[0].config.notificationIDList = { 999: true }; },
        (data) => { data.monitors[0].oldId = 1; },
        (data) => { data.statusPage.groups[0].monitorList[0].id = 999; },
        (data) => { data.settings.disableAuth = true; },
        (data) => { data.manualSettingsReviewed = false; },
    ]) {
        const data = fixture();
        mutate(data);
        assert.throws(() => validate(data));
    }
});

test("TLS patch refuses changed upstream source before writing anything", () => {
    let writes = 0;
    const source = fs.readFileSync(require.resolve("../scripts/patch-database-tls.cjs"), "utf8");
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

test("timezone initialization keeps the explicit preference before first browser login", async () => {
    const socket = new EventEmitter();
    socket.on("initServerTimezone", (timezone) => {
        assert.equal(timezone, "UTC");
        socket.emit("info", { serverTimezone: "Europe/London" });
        queueMicrotask(() => socket.emit("info", { serverTimezone: timezone }));
    });
    await initializeTimezone(socket, "UTC");
    assert.equal(socket.listenerCount("info"), 0);
    assert.throws(() => initializeTimezone(socket, null), /Invalid source timezone/);
});
