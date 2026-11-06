"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { io } = require("/app/node_modules/socket.io-client");
const mysql = require("/app/node_modules/mysql2/promise");

// Synthetic fixture only; dependencies come from the image under test.
const password = "SyntheticAdminOnly42!";
const baseURL = "http://kuma:3001";
const socket = io(baseURL, {
    autoConnect: false,
    reconnection: false,
    transports: ["websocket"],
    timeout: 10000,
});

function call(event, ...args) {
    return new Promise((resolve, reject) => {
        socket.timeout(15000).emit(event, ...args, (error, result) => {
            if (error) {
                reject(new Error(`${event}: ${error.message}`, { cause: error }));
            } else if (!result?.ok) {
                reject(new Error(`${event}: ${JSON.stringify(result)}`));
            } else {
                resolve(result);
            }
        });
    });
}

async function main() {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fresh instance did not request setup")), 15000);
        socket.once("setup", () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once("connect_error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        socket.connect();
    });
    await call("setup", "synthetic-admin", password);
    await call("login", { username: "synthetic-admin", password });
    const notification = {
        name: "Synthetic notification",
        type: "webhook",
        isDefault: false,
        applyExisting: false,
        webhookURL: "http://127.0.0.1:9/synthetic-only",
        webhookContentType: "json",
        webhookAdditionalHeaders: '{"Authorization":"Bearer synthetic-only"}',
    };
    const notificationId = (await call("addNotification", notification, null)).id;
    const monitors = new Map();
    for (let index = 1; index <= 6; index++) {
        const configuration = {
            name: `Synthetic monitor ${index}`,
            type: "http",
            url: "http://127.0.0.1:3001/setup-database-info",
            method: "GET",
            interval: 60,
            retryInterval: 60,
            timeout: 10,
            maxretries: 1,
            headers: '{"X-Synthetic-Header":"synthetic-private-value"}',
            basic_auth_user: "synthetic-user",
            basic_auth_pass: "synthetic-password",
            active: false,
            accepted_statuscodes: ["200-299"],
            notificationIDList: { [notificationId]: true },
            conditions: [],
        };
        const result = await call("add", configuration);
        monitors.set(result.monitorID, configuration);
        const { monitor } = await call("getMonitor", result.monitorID);
        assert.equal(monitor.name, configuration.name);
        assert.equal(Boolean(monitor.active), false);
        assert.ok(monitor.notificationIDList[notificationId]);
    }

    await call("addStatusPage", "Synthetic status", "synthetic");
    const { config } = await call("getStatusPage", "synthetic");
    const publicMonitorIDs = [...monitors.keys()].reverse();
    await call("saveStatusPage", "synthetic", {
        ...config,
        description: "Synthetic application configuration",
        domainNameList: [],
        analyticsType: null,
    }, "", [{
        name: "Synthetic services",
        monitorList: publicMonitorIDs.map((id) => ({ id, sendUrl: false })),
    }]);
    const { data: settings } = await call("getSettings");
    await call("setSettings", {
        ...settings,
        entryPage: "statusPage-synthetic",
        serverTimezone: "UTC",
    }, password);
    const actualSettings = (await call("getSettings")).data;
    assert.equal(actualSettings.entryPage, "statusPage-synthetic");
    assert.equal(actualSettings.serverTimezone, "UTC");
    const pageResponse = await fetch(`${baseURL}/api/status-page/synthetic`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    assert.equal(page.publicGroupList[0].monitorList.length, 6);
    assert.deepEqual(
        page.publicGroupList[0].monitorList.map((monitor) => monitor.id),
        publicMonitorIDs,
    );
    const db = await mysql.createConnection({
        host: "mysql",
        user: "kuma",
        password: "SyntheticDatabaseOnly42!",
        database: "kuma",
        ssl: { rejectUnauthorized: true, verifyIdentity: true, ca: [fs.readFileSync("/certs/ca.pem")] },
    });
    try {
        for (const [id, configuration] of monitors) {
            const [rows] = await db.execute("SELECT * FROM monitor WHERE id = ?", [id]);
            assert.equal(rows.length, 1);
            for (const [key, value] of Object.entries(configuration)) {
                if (key === "notificationIDList") {
                    continue;
                }
                const column = key === "accepted_statuscodes" ? "accepted_statuscodes_json" : key;
                const actual = key === "active" ? Boolean(rows[0][column])
                    : ["accepted_statuscodes", "conditions"].includes(key) ? JSON.parse(rows[0][column])
                        : rows[0][column];
                assert.deepEqual(actual, value, `Field not persisted: ${key}`);
            }
        }
        const [notifications] = await db.query("SELECT config FROM notification");
        assert.equal(notifications.length, 1);
        assert.deepEqual(JSON.parse(notifications[0].config), notification);
        const [links] = await db.query("SELECT monitor_id, notification_id FROM monitor_notification");
        assert.equal(links.length, 6);
        assert.ok(links.every((link) => link.notification_id === notificationId));
        assert.deepEqual(new Set(links.map((link) => link.monitor_id)), new Set(monitors.keys()));
        const [active] = await db.query("SELECT COUNT(*) AS count FROM monitor WHERE active = 1");
        assert.equal(active[0].count, 0, "Configuration must not start monitors or send notifications");
        console.log("PASS: application API persisted paused monitors, HTTP fields, notification credentials and links, status-page order, and app settings");

        const testId = (await call("add", {
            name: "Synthetic runtime probe", type: "http",
            url: "http://127.0.0.1:3001/setup-database-info",
            interval: 20, retryInterval: 20, timeout: 5, active: false,
            accepted_statuscodes: ["200-299"], notificationIDList: {}, conditions: [],
        })).monitorID;
        try {
            await call("resumeMonitor", testId);
            let healthy = false;
            for (let attempt = 0; attempt < 30; attempt++) {
                const [beats] = await db.execute(
                    "SELECT status FROM heartbeat WHERE monitor_id = ? ORDER BY id DESC LIMIT 1", [testId],
                );
                if (beats[0]?.status === 1) {
                    healthy = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            assert.ok(healthy, "Synthetic HTTP monitor did not persist an UP heartbeat to MySQL");
            console.log("PASS: real Kuma HTTP polling persisted an UP heartbeat to MySQL over verified TLS");
        } finally {
            await call("pauseMonitor", testId);
            await call("deleteMonitor", testId, false);
        }
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => socket.close());
