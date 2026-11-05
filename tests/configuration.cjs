"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { io } = require("/app/node_modules/socket.io-client");
const mysql = require("/app/node_modules/mysql2/promise");

// Synthetic fixture only, NOT a general-purpose importer for private backups.
const password = "SyntheticAdminOnly42!";
const socket = io("http://kuma:3001", {
    autoConnect: false,
    reconnection: false,
    transports: ["websocket"],
    timeout: 10000,
});

function call(event, ...args) {
    return new Promise((resolve, reject) => {
        socket.timeout(15000).emit(event, ...args, (error, result) => {
            if (error) {
                reject(error);
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
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
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
    const notificationMap = new Map([
        [42, (await call("addNotification", notification, null)).id],
    ]);
    const monitorMap = new Map();
    for (const oldID of [101, 103, 107, 109, 113, 127]) {
        const result = await call("add", {
            name: `Synthetic monitor ${oldID}`,
            type: "http",
            url: "http://127.0.0.1:3001/setup-database-info",
            method: "GET",
            interval: 60,
            retryInterval: 60,
            timeout: 10,
            maxretries: 1,
            active: false,
            accepted_statuscodes: ["200-299"],
            notificationIDList: { [notificationMap.get(42)]: true },
            conditions: [],
        });
        monitorMap.set(oldID, result.monitorID);
        const { monitor } = await call("getMonitor", result.monitorID);
        assert.equal(monitor.name, `Synthetic monitor ${oldID}`);
        assert.equal(Boolean(monitor.active), false);
        assert.ok(monitor.notificationIDList[notificationMap.get(42)]);
    }

    await call("addStatusPage", "Synthetic status", "synthetic");
    const { config } = await call("getStatusPage", "synthetic");
    await call("saveStatusPage", "synthetic", {
        ...config,
        description: "Synthetic configuration-only migration",
        domainNameList: [],
        analyticsType: null,
    }, "", [{
        name: "Synthetic services",
        monitorList: [...monitorMap.values()].map((id) => ({ id, sendUrl: false })),
    }]);
    const { data: settings } = await call("getSettings");
    await call("setSettings", {
        ...settings,
        entryPage: "statusPage-synthetic",
        serverTimezone: "UTC",
    }, password);
    const restoredSettings = (await call("getSettings")).data;
    assert.equal(restoredSettings.entryPage, "statusPage-synthetic");
    assert.equal(restoredSettings.serverTimezone, "UTC");
    const pageResponse = await fetch("http://kuma:3001/api/status-page/synthetic");
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    assert.equal(page.publicGroupList[0].monitorList.length, 6);
    assert.deepEqual(
        page.publicGroupList[0].monitorList.map((monitor) => monitor.id).sort((a, b) => a - b),
        [...monitorMap.values()].sort((a, b) => a - b),
    );

    const db = await mysql.createConnection({
        host: "mysql",
        user: "kuma",
        password: "SyntheticDatabaseOnly42!",
        database: "kuma",
        ssl: { rejectUnauthorized: true, verifyIdentity: true, ca: [fs.readFileSync("/certs/ca.pem")] },
    });
    try {
        const [notifications] = await db.query("SELECT config FROM notification");
        assert.equal(notifications.length, 1);
        assert.equal(
            JSON.parse(notifications[0].config).webhookAdditionalHeaders,
            notification.webhookAdditionalHeaders,
        );
        const [links] = await db.query("SELECT monitor_id, notification_id FROM monitor_notification");
        assert.equal(links.length, 6);
        assert.ok(links.every((link) => link.notification_id === notificationMap.get(42)));
        const [active] = await db.query("SELECT COUNT(*) AS count FROM monitor WHERE active = 1");
        assert.equal(active[0].count, 0, "Restoration must not start monitors or send notifications");
        console.log("PASS: application API recreated 6 paused monitors, notification credentials and links, status page/groups, and app settings");
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => socket.close());
