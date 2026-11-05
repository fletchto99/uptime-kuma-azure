"use strict";

const fs = require("node:fs");
const assert = require("node:assert/strict");
const required = [
    "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID",
    "AZURE_RESOURCE_GROUP", "AZURE_WEBAPP_NAME",
];
const response = JSON.parse(fs.readFileSync(0, "utf8"));
const values = new Map(response.variables.map(({ name, value }) => [name, value]));
for (const name of required) {
    const value = values.get(name);
    assert.ok(typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value), `Missing or invalid ${name}`);
}
for (const name of required) {
    const value = values.get(name);
    console.log(`::add-mask::${value}`);
    fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}
