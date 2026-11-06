"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "infra", "main.bicep"), "utf8");

test("public access defaults to safe initial setup and changes only main-site rules", () => {
    assert.match(source, /param publicAccess bool = false/);
    assert.match(source, /ipSecurityRestrictionsDefaultAction: publicAccess \? 'Allow' : 'Deny'/);
    assert.match(source, /ipSecurityRestrictions: publicAccess \? \[\] : \[/);
});

test("SCM has independent deny-by-default operator access in both modes", () => {
    assert.match(source, /scmIpSecurityRestrictionsUseMain: false/);
    assert.match(source, /scmIpSecurityRestrictionsDefaultAction: 'Deny'/);
    const block = source.match(/scmIpSecurityRestrictions: \[([\s\S]*?)\n      \]/);
    assert.ok(block);
    assert.match(block[1], /name: 'operator-only-scm'/);
    assert.match(block[1], /action: 'Allow'/);
    assert.match(block[1], /ipAddress: '\$\{operatorIPv4\}\/32'/);
    assert.ok(!block[1].includes("publicAccess"), "SCM must not depend on main-site publication");
});

test("public flag is not used for database or credential policy changes", () => {
    const database = source.slice(source.indexOf("resource mysql "), source.indexOf("resource app "));
    assert.ok(!database.includes("publicAccess"));
    assert.match(source, /ftpsState: 'Disabled'/);
    assert.match(source, /resource ftpPolicy[\s\S]*?allow: false/);
    assert.match(source, /resource scmPolicy[\s\S]*?allow: false/);
    assert.match(source, /httpsOnly: true/);
});
