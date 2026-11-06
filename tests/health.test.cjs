"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { createCheck, register } = require("../runtime/health.cjs");

function logger() {
    const messages = [];
    return { messages, warn: (...args) => messages.push(args), info: (...args) => messages.push(args) };
}

test("health coalesces concurrent queries and briefly caches healthy results", async () => {
    let calls = 0;
    const check = createCheck(async () => { calls++; await delay(5); }, logger());
    assert.deepEqual(await Promise.all(Array.from({ length: 100 }, () => check())), Array(100).fill(true));
    assert.equal(await check(), true);
    assert.equal(calls, 1);
});

test("health timeout returns unavailable and cannot queue further work behind an unsettled query", async () => {
    let calls = 0;
    let complete;
    const log = logger();
    const check = createCheck(() => { calls++; return new Promise((resolve) => { complete = resolve; }); },
        log, { deadlineMs: 20, cacheMs: 10 });
    const start = Date.now();
    assert.equal(await check(), false);
    assert.ok(Date.now() - start < 1000);
    await delay(15);
    assert.deepEqual(await Promise.all(Array.from({ length: 100 }, () => check())), Array(100).fill(false));
    assert.equal(calls, 1);
    complete();
    await delay(0);
    assert.equal(log.messages.length, 1, "Late success must not erase the timed-out result");
});

test("database errors are logged generically and recovery is explicit", async () => {
    let failing = true;
    const log = logger();
    const check = createCheck(async () => { if (failing) { throw new Error("secret password and internal hostname"); } },
        log, { deadlineMs: 100, cacheMs: 1 });
    assert.equal(await check(), false);
    assert.ok(!JSON.stringify(log.messages).includes("secret"));
    failing = false;
    await delay(5);
    assert.equal(await check(), true);
    assert.equal(log.messages.length, 2);
    assert.match(log.messages[1][1], /recovered/);
});

test("public route checks read-only flags with one bounded SELECT and minimal direct responses", async (t) => {
    for (const { name, rows, healthy = false, reject = false } of [
        { name: "writable", rows: [{ read_only: 0, super_read_only: 0 }], healthy: true },
        { name: "read-only", rows: [{ read_only: 1, super_read_only: 0 }] },
        { name: "super read-only", rows: [{ read_only: 1, super_read_only: 1 }] },
        { name: "super read-only alone", rows: [{ read_only: 0, super_read_only: 1 }] },
        { name: "missing flags", rows: [{}] },
        { name: "missing super read-only flag", rows: [{ read_only: 0 }] },
        { name: "missing read-only flag", rows: [{ super_read_only: 0 }] },
        { name: "unexpected flag types", rows: [{ read_only: "0", super_read_only: "0" }] },
        { name: "no rows", rows: [] },
        { name: "missing rows" },
        { name: "extra rows", rows: [{ read_only: 0, super_read_only: 0 }, {}] },
        { name: "database error", reject: true },
    ]) {
        await t.test(name, async () => {
            let handler;
            let calls = 0;
            const log = logger();
            const app = { get(route, callback) { assert.equal(route, "/healthz"); handler = callback; } };
            const R = { knex: { client: { config: { client: "mysql2" } }, raw(sql) {
                calls++;
                assert.equal(sql, "SELECT @@GLOBAL.read_only AS read_only, @@GLOBAL.super_read_only AS super_read_only");
                return { timeout(milliseconds, options) {
                    assert.equal(milliseconds, 1000);
                    assert.deepEqual(options, { cancel: true });
                    return reject ? Promise.reject(new Error("private details")) : Promise.resolve([rows, []]);
                } };
            } } };
            register(app, R, log);
            const result = {};
            const response = {
                set(name, value) { result[name] = value; return this; },
                status(code) { result.code = code; return this; },
                json(body) { result.body = body; },
            };
            await handler({}, response);
            assert.equal(result.code, healthy ? 200 : 503);
            assert.equal(result["Cache-Control"], "no-store");
            assert.deepEqual(result.body, { status: healthy ? "ok" : "unavailable" });
            assert.equal(calls, 1);
            assert.deepEqual(log.messages, healthy ? [] : [
                ["health", "Application database health check failed or timed out"],
            ]);
        });
    }
});
