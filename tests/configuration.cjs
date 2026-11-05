"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { io } = require("/app/node_modules/socket.io-client");
const mysql = require("/app/node_modules/mysql2/promise");

// Synthetic fixture only, NOT a general-purpose importer for private backups.
const password = "SyntheticAdminOnly42!";
const baseURL = `http://${process.env.KUMA_TEST_HOST || "kuma"}:3001`;
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
        socket.once(process.env.VERIFY_IMPORTED_REPORT ? "info" : "setup", () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once("connect_error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        socket.connect();
    });
    if (!process.env.VERIFY_IMPORTED_REPORT) {
        await call("setup", "synthetic-admin", password);
    }
    await call("login", { username: "synthetic-admin", password });
    if (process.env.CREATE_ADMIN_ONLY === "true") {
        return;
    }
    if (process.env.IMPORT_MANIFEST) {
        const manifest = JSON.parse(fs.readFileSync(process.env.IMPORT_MANIFEST, "utf8"));
        const { restore } = require("/restore.cjs");
        const result = process.env.VERIFY_IMPORTED_REPORT
            ? JSON.parse(fs.readFileSync(process.env.VERIFY_IMPORTED_REPORT, "utf8"))
            : await restore(socket, manifest, password);
        const db = await mysql.createConnection({
            host: "mysql", user: "kuma", password: "SyntheticDatabaseOnly42!", database: "kuma",
            dateStrings: true,
            timezone: "Z",
            ssl: { rejectUnauthorized: true, verifyIdentity: true, ca: [fs.readFileSync("/certs/ca.pem")] },
        });
        try {
            const jsonFields = {
                accepted_statuscodes: "accepted_statuscodes_json",
                kafkaProducerBrokers: "kafka_producer_brokers",
                kafkaProducerSaslOptions: "kafka_producer_sasl_options",
                rabbitmqNodes: "rabbitmq_nodes",
                conditions: "conditions",
            };
            for (const item of manifest.monitors) {
                const [rows] = await db.execute("SELECT * FROM monitor WHERE id = ?", [result.monitorMap[item.oldId]]);
                assert.equal(rows[0].active, 0);
                for (const [key, value] of Object.entries(item.config)) {
                    if (key === "notificationIDList") {
                        continue;
                    }
                    const actual = rows[0][jsonFields[key] || key];
                    assert.deepEqual(key in jsonFields ? JSON.parse(actual) : actual, value, `Field lost: ${key}`);
                }
            }
            const [notifications] = await db.query("SELECT config FROM notification");
            assert.deepEqual(JSON.parse(notifications[0].config), {
                ...manifest.notifications[0].config, applyExisting: false,
            });
            const response = await fetch(`${baseURL}/api/status-page/synthetic`);
            const page = await response.json();
            assert.deepEqual(page.publicGroupList[0].monitorList.map((monitor) => monitor.id),
                manifest.statusPage.groups[0].monitorList.map((monitor) => result.monitorMap[monitor.id]));
            console.log("PASS: stopped SQLite export -> UI API -> MySQL preserved every exported HTTP field, credentials, references, order and app settings; all monitors paused");
            const testId = (await call("add", {
                name: "Synthetic runtime probe", type: "http",
                url: "http://127.0.0.1:3001/setup-database-info",
                interval: 20, retryInterval: 20, timeout: 5, active: false,
                accepted_statuscodes: ["200-299"], notificationIDList: {}, conditions: [],
            })).monitorID;
            await call("resumeMonitor", testId);
            try {
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
        return;
    }
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
            headers: '{"X-Synthetic-Header":"synthetic-private-value"}',
            basic_auth_user: "synthetic-user",
            basic_auth_pass: "synthetic-password",
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
    const publicMonitorIDs = [...monitorMap.values()].reverse();
    await call("saveStatusPage", "synthetic", {
        ...config,
        description: "Synthetic configuration-only migration",
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
    const restoredSettings = (await call("getSettings")).data;
    assert.equal(restoredSettings.entryPage, "statusPage-synthetic");
    assert.equal(restoredSettings.serverTimezone, "UTC");
    const pageResponse = await fetch(`${baseURL}/api/status-page/synthetic`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    assert.equal(page.publicGroupList[0].monitorList.length, 6);
    assert.deepEqual(
        page.publicGroupList[0].monitorList.map((monitor) => monitor.id),
        publicMonitorIDs,
    );
    if (process.env.SEED_SQLITE === "true") {
        console.log("PASS: synthetic SQLite source configured through the application");
        return;
    }

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
