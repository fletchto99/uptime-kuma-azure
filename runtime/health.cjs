"use strict";

function createCheck(query, log, { deadlineMs = 1500, cacheMs = 2000 } = {}) {
    let task = null;
    let response = null;
    let cached = false;
    let expires = 0;
    let reported = null;
    return function check() {
        if (Date.now() < expires) { return Promise.resolve(cached); }
        if (task) { return response; }
        let resolve;
        let settled = false;
        response = new Promise((done) => { resolve = done; });
        const finish = (healthy) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            cached = healthy;
            expires = Date.now() + cacheMs;
            if (!healthy && reported !== false) {
                log.warn("health", "Application database health check failed or timed out");
            } else if (healthy && reported === false) {
                log.info("health", "Application database health check recovered");
            }
            reported = healthy;
            resolve(healthy);
        };
        const timer = setTimeout(() => finish(false), deadlineMs);
        task = Promise.resolve().then(query);
        task.then(() => finish(true), () => finish(false)).finally(() => {
            // After an HTTP deadline, retain the one underlying task until it settles.
            // New public requests cannot queue more pool acquisitions behind a hung query.
            task = null;
        });
        return response;
    };
}

function register(app, R, log) {
    const check = createCheck(() => R.knex.raw("SELECT 1").timeout(1000, {
        cancel: R.knex.client.config.client === "mysql2",
    }), log);
    app.get("/healthz", async (_request, response) => {
        const healthy = await check();
        if (!response.destroyed) {
            response.set("Cache-Control", "no-store").status(healthy ? 200 : 503)
                .json({ status: healthy ? "ok" : "unavailable" });
        }
    });
}

module.exports = { createCheck, register };
