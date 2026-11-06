"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

function call(socket, event, ...args) {
    return new Promise((resolve, reject) => {
        socket.timeout(15000).emit(event, ...args, (error, result) => {
            if (error || !result?.ok) {
                reject(new Error(`${event} failed; inspect privately before retrying (partial import possible)`));
            } else {
                resolve(result);
            }
        });
    });
}

function validate(manifest) {
    assert.equal(manifest.format, 1, "Unsupported manifest format");
    assert.equal(manifest.monitors.length, 6, "Expected six monitors");
    assert.equal(manifest.notifications.length, 1, "Expected one notification");
    assert.ok(manifest.manualSettingsReviewed, "Review manualSettings privately before import");
    assert.ok(!manifest.settings.disableAuth, "Do not disable authentication during restoration");
    const ids = new Set(manifest.monitors.map((monitor) => monitor.oldId));
    assert.equal(ids.size, 6, "Duplicate monitor IDs");
    const notificationId = String(manifest.notifications[0].oldId);
    for (const { config } of manifest.monitors) {
        assert.equal(config.type, "http", "Only HTTP monitors are supported");
        for (const key of ["parent", "proxy_id", "docker_host", "remote_browser"]) {
            assert.ok(config[key] == null || config[key] === 0, "Unsupported monitor reference");
        }
        assert.deepEqual(Object.keys(config.notificationIDList), [notificationId], "Unknown notification mapping");
        assert.ok(Array.isArray(config.accepted_statuscodes), "Invalid accepted status codes");
    }
    const members = manifest.statusPage.groups.flatMap((group) => group.monitorList);
    assert.equal(members.length, 6, "Expected six public monitor references");
    assert.equal(new Set(members.map((monitor) => monitor.id)).size, 6);
    assert.ok(members.every((monitor) => ids.has(monitor.id)), "Unknown public monitor reference");
}

function initializeTimezone(socket, timezone) {
    assert.ok(typeof timezone === "string" && timezone.length > 0, "Invalid source timezone");
    return new Promise((resolve, reject) => {
        const onInfo = (info) => {
            if (info.serverTimezone === timezone) {
                clearTimeout(timer);
                socket.off("info", onInfo);
                resolve();
            }
        };
        const timer = setTimeout(() => {
            socket.off("info", onInfo);
            reject(new Error("Timezone initialization was not confirmed"));
        }, 15000);
        socket.on("info", onInfo);
        socket.emit("initServerTimezone", timezone);
    });
}

async function restore(socket, manifest, currentPassword) {
    validate(manifest);
    const notificationId = (await call(socket, "addNotification", {
        ...manifest.notifications[0].config, applyExisting: false,
    }, null)).id;
    const monitorMap = {};
    for (const item of manifest.monitors) {
        const response = await call(socket, "add", {
            ...item.config,
            active: false,
            notificationIDList: { [notificationId]: true },
        });
        monitorMap[item.oldId] = response.monitorID;
        const { monitor } = await call(socket, "getMonitor", response.monitorID);
        assert.ok(!monitor.active, "Restored monitor unexpectedly active");
        assert.ok(monitor.notificationIDList[notificationId], "Notification link was not restored");
    }
    const { config, logo, groups } = manifest.statusPage;
    await call(socket, "addStatusPage", config.title, config.slug);
    const defaults = (await call(socket, "getStatusPage", config.slug)).config;
    await call(socket, "saveStatusPage", config.slug, { ...defaults, ...config }, logo, groups.map((group) => ({
        name: group.name,
        monitorList: group.monitorList.map((monitor) => ({
            ...monitor, id: monitorMap[monitor.id],
        })),
    })));
    await call(socket, "setSettings", manifest.settings, currentPassword);
    if (Object.hasOwn(manifest.settings, "serverTimezone")) {
        // Regenerate the marker so first browser login cannot replace the restored preference.
        await initializeTimezone(socket, manifest.settings.serverTimezone);
    }
    const actualSettings = (await call(socket, "getSettings")).data;
    for (const [key, value] of Object.entries(manifest.settings)) {
        assert.deepEqual(actualSettings[key], value, "A setting did not round-trip");
    }
    return {
        notificationMap: { [manifest.notifications[0].oldId]: notificationId },
        monitorMap,
        originallyActive: manifest.monitors.filter((item) => item.wasActive).map((item) => monitorMap[item.oldId]),
    };
}

async function login(socket, username, password) {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Server did not send initial information")), 15000);
        socket.once("info", () => { clearTimeout(timer); resolve(); });
        socket.once("connect_error", () => { clearTimeout(timer); reject(new Error("Connection failed")); });
        socket.connect();
    });
    await call(socket, "login", { username, password });
}

async function main() {
    assert.ok(!process.env.GITHUB_ACTIONS, "Private import CLI must not run in Actions");
    const [file, report] = process.argv.slice(2);
    assert.ok(file && report, "Supply private manifest and NEW private report paths");
    assert.ok(!fs.existsSync(report), "Report exists; do not retry an import blindly");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    validate(manifest);
    const url = new URL(process.env.KUMA_URL);
    assert.ok(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
    assert.ok(!url.username && !url.password, "Credentials must not be in the URL");
    assert.ok(process.env.KUMA_USERNAME && process.env.KUMA_PASSWORD, "Supply administrator credentials privately");
    const { io } = require("socket.io-client");
    const socket = io(url.origin, { autoConnect: false, reconnection: false, transports: ["websocket"] });
    const inventory = {};
    for (const event of ["monitorList", "notificationList", "statusPageList"]) {
        socket.on(event, (value) => { inventory[event] = value; });
    }
    try {
        await login(socket, process.env.KUMA_USERNAME, process.env.KUMA_PASSWORD);
        for (const event of ["monitorList", "notificationList", "statusPageList"]) {
            assert.ok(inventory[event] && Object.keys(inventory[event]).length === 0,
                "Target must be a fresh instance with only a new administrator");
        }
        const mapping = await restore(socket, manifest, process.env.KUMA_PASSWORD);
        fs.writeFileSync(report, JSON.stringify(mapping, null, 2), { flag: "wx", mode: 0o600 });
        console.log("Restored configuration; all six monitors remain paused. Verify privately before cutover.");
    } finally {
        socket.close();
    }
}

module.exports = { restore, validate, call, login, initializeTimezone };
if (require.main === module) {
    main().catch((error) => {
        const detail = error.name === "Error" || error.code === "ERR_ASSERTION"
            ? error.message.split("\n")[0] : error.name;
        console.error(`Restore stopped: ${detail}. Partial configuration may exist; inspect privately before retrying.`);
        process.exitCode = 1;
    });
}
