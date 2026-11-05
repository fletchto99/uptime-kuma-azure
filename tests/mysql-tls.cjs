"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const mysql = require("/app/node_modules/mysql2/promise");

const ca = fs.readFileSync("/certs/ca.pem");
const untrustedCA = fs.readFileSync("/certs/untrusted-ca.pem");

async function connect(host, ssl) {
    const connection = await mysql.createConnection({
        host,
        user: "kuma",
        password: "SyntheticDatabaseOnly42!",
        database: "kuma",
        ssl,
        connectTimeout: 10000,
    });
    try {
        const [version] = await connection.query("SELECT VERSION() AS version");
        assert.match(version[0].version, /^8\.4\.9/);
        const [cipher] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
        assert.ok(cipher[0].Value, "Connection must actually use TLS");
        return { version: version[0].version, cipher: cipher[0].Value };
    } finally {
        await connection.end();
    }
}

async function rejects(label, host, ssl, expected) {
    try {
        await connect(host, ssl);
    } catch (error) {
        assert.match(`${error.code}: ${error.message}`, expected, label);
        console.log(`PASS: ${label} (${error.code})`);
        return true;
    }
    console.error(`FAIL: ${label}: connection was accepted`);
    return false;
}

async function main() {
    console.log(`Bundled mysql2: ${require("/app/node_modules/mysql2/package.json").version}`);
    // These are the SSL fields passed by unmodified Kuma 2.5.9.
    const stockSSL = { rejectUnauthorized: true, ca: [ca] };
    const good = await connect("mysql", stockSSL);
    console.log(`PASS: trusted certificate and matching hostname: MySQL ${good.version}, ${good.cipher}`);

    const untrustedRejected = await rejects(
        "untrusted CA is rejected",
        "mysql",
        { rejectUnauthorized: true, ca: [untrustedCA] },
        /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|self-signed certificate in certificate chain/,
    );
    const controlRejected = await rejects(
        "control with verifyIdentity=true rejects mismatched hostname",
        "wrong-name",
        { ...stockSSL, verifyIdentity: true },
        /ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match/,
    );
    // compatibility.sh checks the real app's hostname behavior, so a future
    // fixed release is not blocked by replaying the old release's SSL options.
    if (!untrustedRejected || !controlRejected) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
