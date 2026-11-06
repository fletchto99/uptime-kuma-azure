"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

async function runFixture({ heartbeat = true, corruptField = false, corruptLinks = false, corruptRetryInterval = false } = {}) {
    const state = { monitors: new Map(), settings: {}, errors: [], resumed: [], deleted: [], heartbeatReads: 0 };
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const socket = new EventEmitter();
    socket.connect = () => socket.emit("setup");
    socket.close = () => { state.socketClosed = true; finish(); };
    socket.timeout = () => ({
        emit(event, ...args) {
            const callback = args.pop();
            let result = { ok: true };
            switch (event) {
                case "setup":
                case "login":
                case "addStatusPage":
                    break;
                case "addNotification":
                    state.notification = args[0];
                    result.id = 23;
                    break;
                case "add":
                    result.monitorID = state.monitors.size + 100;
                    state.monitors.set(result.monitorID, { ...args[0] });
                    break;
                case "getMonitor":
                    result.monitor = state.monitors.get(args[0]);
                    break;
                case "getStatusPage":
                    result.config = { slug: "synthetic" };
                    break;
                case "saveStatusPage":
                    state.groups = args[3];
                    break;
                case "getSettings":
                    result.data = state.settings;
                    break;
                case "setSettings":
                    state.settings = args[0];
                    break;
                case "resumeMonitor":
                    assert.deepEqual(state.monitors.get(args[0]).notificationIDList, {});
                    state.resumed.push(args[0]);
                    state.monitors.get(args[0]).active = true;
                    break;
                case "pauseMonitor":
                    state.monitors.get(args[0]).active = false;
                    break;
                case "deleteMonitor":
                    assert.equal(state.monitors.get(args[0]).active, false);
                    state.monitors.delete(args[0]);
                    state.deleted.push(args[0]);
                    break;
                default:
                    throw new Error(`Unexpected Socket.IO event: ${event}`);
            }
            callback(null, result);
        },
    });
    const db = {
        async execute(sql, [id]) {
            const monitor = state.monitors.get(id);
            if (sql === "SELECT * FROM monitor WHERE id = ?") {
                return [[{
                    name: monitor.name,
                    type: monitor.type,
                    url: monitor.url,
                    method: monitor.method,
                    interval: monitor.interval,
                    retry_interval: corruptRetryInterval ? 999 : monitor.retryInterval,
                    timeout: monitor.timeout,
                    maxretries: monitor.maxretries,
                    headers: corruptField ? "wrong headers" : monitor.headers,
                    basic_auth_user: monitor.basic_auth_user,
                    basic_auth_pass: monitor.basic_auth_pass,
                    active: Number(monitor.active),
                    accepted_statuscodes_json: JSON.stringify(monitor.accepted_statuscodes),
                    conditions: JSON.stringify(monitor.conditions),
                }]];
            }
            assert.equal(sql, "SELECT status FROM heartbeat WHERE monitor_id = ? ORDER BY id DESC LIMIT 1");
            assert.equal(monitor.active, true);
            state.heartbeatReads++;
            return [heartbeat ? [{ status: 1 }] : []];
        },
        async query(sql) {
            switch (sql) {
                case "SELECT config FROM notification":
                    return [[{ config: JSON.stringify(state.notification) }]];
                case "SELECT monitor_id, notification_id FROM monitor_notification":
                    return [[...state.monitors.keys()].map((id) => ({
                        monitor_id: corruptLinks ? 999 : id, notification_id: 23,
                    }))];
                case "SELECT COUNT(*) AS count FROM monitor WHERE active = 1":
                    return [[{ count: [...state.monitors.values()].filter((monitor) => monitor.active).length }]];
                default:
                    throw new Error(`Unexpected SQL: ${sql}`);
            }
        },
        async end() { state.databaseClosed = true; },
    };
    const run = vm.compileFunction(
        fs.readFileSync(require.resolve("./configuration.cjs"), "utf8") + "\nreturn done;",
        ["require", "process", "console", "setTimeout", "clearTimeout", "fetch", "done"],
    );
    const process = {};
    await run((name) => {
        switch (name) {
            case "/app/node_modules/socket.io-client":
                return { io: () => socket };
            case "/app/node_modules/mysql2/promise":
                return {
                    async createConnection(options) {
                        assert.equal(options.ssl.rejectUnauthorized, true);
                        assert.equal(options.ssl.verifyIdentity, true);
                        return db;
                    },
                };
            case "node:fs":
                return { readFileSync: () => "synthetic CA" };
            case "node:assert/strict":
                return assert;
            default:
                throw new Error(`Unexpected dependency: ${name}`);
        }
    }, process, {
        log() {},
        error(error) { state.errors.push(error); },
    }, (callback, ms) => setTimeout(callback, ms === 1000 ? 0 : ms), clearTimeout, async (url) => {
        assert.equal(url, "http://kuma:3001/api/status-page/synthetic");
        return { status: 200, json: async () => ({ publicGroupList: state.groups }) };
    }, done);
    return { ...state, exitCode: process.exitCode };
}

test("direct configuration fixture checks persistence and an UP heartbeat, then cleans up its probe", async () => {
    const result = await runFixture();
    assert.deepEqual(result.errors, []);
    assert.equal(result.exitCode, undefined);
    assert.equal(result.monitors.size, 6);
    assert.ok([...result.monitors.values()].every((monitor) => !monitor.active));
    assert.equal(result.resumed.length, 1);
    assert.deepEqual(result.deleted, result.resumed);
    assert.equal(result.heartbeatReads, 1);
    assert.equal(result.socketClosed, true);
    assert.equal(result.databaseClosed, true);
});

test("missing UP heartbeat fails after bounded polling and still cleans up the probe", async () => {
    const result = await runFixture({ heartbeat: false });
    assert.equal(result.exitCode, 1);
    assert.match(result.errors[0].message, /did not persist an UP heartbeat/);
    assert.equal(result.heartbeatReads, 30);
    assert.deepEqual(result.deleted, result.resumed);
    assert.equal(result.socketClosed, true);
    assert.equal(result.databaseClosed, true);
});

test("a wrong persisted retry_interval fails before starting the runtime probe", async () => {
    const result = await runFixture({ corruptRetryInterval: true });
    assert.equal(result.exitCode, 1);
    assert.match(result.errors[0].message, /Field not persisted: retryInterval/);
    assert.equal(result.errors[0].actual, 999);
    assert.equal(result.errors[0].expected, 60);
    assert.deepEqual(result.resumed, []);
    assert.equal(result.socketClosed, true);
    assert.equal(result.databaseClosed, true);
});

test("lost HTTP fields or notification associations fail before starting the runtime probe", async () => {
    for (const options of [{ corruptField: true }, { corruptLinks: true }]) {
        const result = await runFixture(options);
        assert.equal(result.exitCode, 1);
        assert.equal(result.errors.length, 1);
        assert.deepEqual(result.resumed, []);
        assert.equal(result.socketClosed, true);
        assert.equal(result.databaseClosed, true);
    }
});
