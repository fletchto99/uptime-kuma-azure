# Managed hosting readiness

## Pilot deployment runbook

The approved direction is App Service B1 plus Azure Database for MySQL Flexible
Server B1ms, using MySQL 8.4 LTS. The approved migration scope is configuration
only, not historical heartbeats or uptime records. No alternative platform,
SQLite synchronization service, or self-managed database is proposed here.

**Current target: West US 2 for the resource group, app and database.** Paid
provisioning requires successful full Provider preflight and explicit release.
Previous Central US, split-region and East US 2 proposals are inactive; retain
their private failure evidence and encrypted credentials as history, not as the
next deployment's parameter inputs. A Portal region/version selection alone
does not prove that the small SKU can be allocated.

The stock Kuma 2.5.9 gate found missing TLS hostname verification. The user
approved the smallest source-checked fix: `verifyIdentity: true` at the two
runtime connection sites and the setup connection. Existing CA handling and
`rejectUnauthorized: true` are unchanged. `scripts/patch-database-tls.cjs`
checks both complete upstream source hashes and expected match counts before
writing anything; upstream changes fail the build rather than silently skipping
the fix.

`infra/main.bicep` compiles offline. The manual update workflow is disabled;
there is no provisioning workflow, schedule, auto-merge, or registry webhook.
This file documents generic code and procedures, not live resource state.
Subscription details, credentials, deployment outputs and approvals stay private.

## Evidence and limits

[Final hosted run on 2026-11-05](https://github.com/fletchto99/uptime-kuma-azure/actions/runs/41985786213)
passed at code revision `d6c429e028a2a973e19327749b8a45730213136b`, with no
Azure resources or private data:

| Check | Result |
| --- | --- |
| Patched official Kuma 2.5.9 initializes MySQL 8.4.9 | Pass, 28 tables and application listening |
| Valid CA and matching hostname | Pass, TLS cipher in use |
| Untrusted CA | Rejected as required |
| Explicit driver `verifyIdentity: true`, wrong hostname | Rejected as required |
| Actual patched Kuma, wrong hostname or untrusted CA | Both rejected |
| Stopped SQLite export and actual private import CLI | Pass, six HTTP monitors paused |
| Every exported HTTP field, notification credentials and remapped associations | Pass |
| Status-page monitor groups/order and app settings | Pass |
| Actual HTTP polling and an UP heartbeat stored in MySQL | Pass |
| Source-change patch guard and unsafe configuration rejection | Pass |
| Update ordering, failure-stop behavior and singleton/approval guards | Pass |
| Bicep compilation and anonymous public image pull | Pass |

Approved-pilot image candidate, published for Linux amd64 and independently
verified anonymously pullable:

```text
ghcr.io/fletchto99/uptime-kuma-azure@sha256:a5b870e1f90016d9bd3ac78600e474b5320a4e8b2349a3fdb29827d59ed0b210
```

Readable tag: `2.5.9-tls-d6c429e028a2`. Deployment must use the digest above, not
the mutable tag. Subsequent tested images are recorded in CI's job summary.
The [original stock-release diagnosis](https://github.com/fletchto99/uptime-kuma-azure/actions/runs/41982440614)
remains available: unmodified 2.5.9 accepted a trusted certificate for the wrong
hostname, which is why the narrow patch exists.

The upstream image index is pinned in `Dockerfile`; it includes Linux amd64,
arm64, and arm/v7 images. CI verifies the readable tag still resolves to that
index and runs amd64. Other architectures have not been runtime-tested.

The selected MySQL image is 8.4.9, the current 8.4 minor version listed by
[Azure's version policy](https://learn.microsoft.com/azure/mysql/concepts-version-policy)
when investigated. Azure manages subsequent minor patches; major upgrades remain
deliberate. MySQL 8.0 is not a fallback: its Azure Standard Support ends on
2027-01-31, followed by charged Extended Support.

Kuma's `mariadb` configuration selects the mysql2 driver; the label does not
itself establish compatibility. The test starts the actual stock app against a
fresh MySQL database and lets Kuma generate its schema. It does not import
SQLite DDL, disable database constraints, or replace application migrations.
Community MySQL in hosted CI is not proof of Azure firewall, capacity, service
configuration, managed certificates, or production workload behavior.

Kuma's released
[database connection configuration](https://github.com/louislam/uptime-kuma/blob/2.5.9/server/database.js)
sets `rejectUnauthorized: true` but does not set `verifyIdentity: true`.
Its bundled
[mysql2 3.11.5 TLS implementation](https://github.com/sidorares/node-mysql2/blob/v3.11.5/lib/base/connection.js)
skips the hostname check without that flag. A trusted CA alone is not sufficient.
The patched image must pass an actual-app mismatched-host test, not only a
standalone driver test. To remove the patch, verify that a released upstream
image implements strict identity verification at all three sites, remove the
Dockerfile patch steps and script, and pass the same negative tests.

## Resources and spending decision

West US 2 CAD retail estimates, at 730 hours/month, before taxes:

| Component | Assumption | Estimated CAD/month |
| --- | --- | ---: |
| Linux App Service plan | West US 2 B1, one worker, CAD0.023864/hour | 17.42072 |
| MySQL Flexible Server compute | West US 2 Burstable B1ms, CAD0.023864/hour | 17.42072 |
| MySQL data storage | West US 2 20 GiB minimum, CAD0.161431/GiB-month | 3.22862 |
| Core subtotal | No HA or replicas | **38.07006** |

CAD50/month is a planning allowance, not a quotation or hard cap. Credits and
account-specific pricing must be checked privately by the owner. The resource
group, application object, and managed identity do not add another compute
instance, but the following variable costs must be included in the live estimate:

- **MySQL backups:** local backups include up to 100% of provisioned storage
  (20 GiB for this starting size). Retained snapshots and transaction logs
  beyond that allowance are billed. Seven-day retention is the intended
  starting point, not unlimited history. Geo-redundant backups are not included
  in this plan.
- **Database growth and I/O:** provisioned storage growth, extra provisioned
  IOPS, or autoscale I/O consumption can add charges. Confirm the selected
  I/O mode and included allowance before creation; do not silently enable paid
  I/O scaling or storage growth and call the budget fixed.
- **Assets:** App Service's persistent `/home` uses the included filesystem
  quota; no additional Azure Files account is needed. Current App Service
  documentation includes automatic hourly backups on Basic, with 30-day
  retention, no separate storage account, and coverage of custom-container
  persistent storage. Verify a restorable snapshot in the pilot. Downloadable
  or on-demand custom backups are optional and require a separately priced
  SAS-authorized Blob account; none is silently added here.
- **Secrets:** encrypted App Service settings need no dedicated secret service.
  If a Key Vault reference is selected, price its operations and any retention
  requirements separately; do not claim Key Vault is free.
- **Traffic:** both services target West US 2, so cross-region
  app-to-database traffic is not part of this topology. Internet egress and
  other applicable service network charges remain additional. Actual traffic
  volume and latency are unmeasured; no latency improvement or blanket free
  usage allowance is assumed.
- **Recovery and migration overlap:** point-in-time recovery creates a new
  billable MySQL server. Any still-provisioned old disks, public IPs, or running
  compute are separate charges; don't assume that stopping/deallocating compute
  removes them. Original infrastructure deletion remains a separate destructive
  approval.
- **Optional services:** no paid registry, Application Insights/Log Analytics
  workspace, private endpoint, NAT gateway, HA replica, or new Azure DNS zone
  is assumed. Adding any later changes the estimate.
- **Existing domain and HTTPS:** reuse the existing DNS provider/domain.
  App Service's managed certificate avoids a separately purchased certificate;
  the domain's existing renewal cost remains external to this subtotal.

Burstable B1ms is for a small, mostly idle workload. CPU-credit exhaustion can
make it slow; it is not an enterprise workload/SLA design. Monitor the existing
platform CPU, credits, storage, backup usage, and connections before considering
a larger paid tier.

References:
[App Service persistent storage](https://learn.microsoft.com/azure/app-service/configure-custom-container#use-persistent-shared-storage),
[MySQL backup billing and restore](https://learn.microsoft.com/azure/mysql/flexible-server/concepts-backup-restore),
[MySQL tiers/storage](https://learn.microsoft.com/azure/mysql/flexible-server/concepts-service-tiers-storage),
[App Service automatic backup coverage](https://learn.microsoft.com/azure/app-service/manage-backup).

## Provisioning and pilot

The parent must approve a concrete IaC preview and live resource estimate before
creation. The intended bounded setup is:

1. One Linux B1 plan and one app, one Kuma worker, Always On, HTTPS-only,
   application port 3001. No slots, scale-out, registry webhooks, or rolling
   deployment automation. The template uses the current `sitecontainers`
   model with one main container, `targetPort: '3001'`, anonymous public image
   pull, and inherited app settings. It does not mix in legacy `WEBSITES_PORT`
   routing. Startup uses `umask 077` for new runtime secret files.
   The plan explicitly depends on successful MySQL database provisioning, so a
   failed database create cannot allocate an otherwise unused paid web worker.
2. One MySQL 8.4 B1ms server, 20 GiB starting storage, local backups, seven-day
   retention, no HA/replicas. Require TLS and restrict public database ingress
   to the app's required outbound addresses plus explicitly approved temporary
   operator access. Do not use the blanket "allow all Azure services" rule.
   MySQL 8.4 is GA, but stable ARM schema `2024-12-30` still excludes it. The
   server uses documented `2025-12-01-preview` ARM API so Bicep can type-check
   `version: '8.4'`; this is an API preview, not a preview engine.
3. Keep uploads, status-page logos, Docker client certificates, and other
   non-database runtime files in the persisted data directory under `/home`;
   enable Linux persistent storage explicitly. Treat that directory as secret:
   Kuma writes the resolved database password to `db-config.json`.
4. Create a dedicated runtime database user scoped to the Kuma database with
   its required DDL/DML migration privileges, not the server administrator.
   The test uses database-scoped privileges, including schema initialization.
   Keep the administrator credential only in the private provisioning process.
   Use a runtime secret or Key Vault reference for the application password.
   Do not claim Kuma can refresh Entra database tokens.
5. The manual Actions update uses OIDC and a protected deployment
   environment. Scope the federated identity to the repository/environment and
   minimum Azure deployment permissions. Tenant/subscription/client IDs are
   nonsecret variables, but stay out of public source/logs per the user's
   privacy requirement. The workflow loads environment variables through the
   authenticated GitHub API and masks them before placing them in the runner
   environment or calling Azure login. A failure to read variables fails before
   Azure login. Verify this environment permission during activation; do not
   fall back to printing IDs or adding persistent Azure credentials. Synthetic
   PR CI gets no Azure permission and must never read production secrets.
6. Deploy only an explicitly approved immutable image. Back up the DB and
   assets, stop the app, verify it is stopped, update the image/settings, and
   start once. Verify health and one configured worker. On failure, stop and
   notify the owner; do not leave a half-updated app or automatically run old
   code against a newly migrated schema. No automatic retry of the entire
   deployment or parallel replacement. Azure platform maintenance is outside
   this procedure; no strict distributed exactly-once claim is made.
7. Leave the manual update activation variable unset until the pilot is
   explicitly released. Dependabot only proposes Docker updates.
   Public CI failures notify through GitHub Actions subscriptions; confirm the
   owner's delivery settings. The workflow emits explicit errors/summary on
   failure, and the script stops a failed replacement. Confirm GitHub Actions
   failure-email delivery (and an independent alert if needed) before activation.

Use a **private operator terminal**, not public Actions, for the explicitly
authorized Provider preflight. Run the creation command only after preflight
succeeds and paid deployment is explicitly released; a configuration reset is
not permission to provision. Use that private terminal
to provide secure parameters and run the preview. Keep the parameters file
outside the repository and restrict its filesystem ACL. It contains both the
administrator and the database-scoped runtime password.
Use a separate preview file with nonsecret dummy passwords for what-if; use
real passwords only for the approved creation with output disabled. Do not
enable debug logging, terminal transcripts, or public output capture.

```powershell
az deployment group what-if --resource-group <approved-group> --template-file .\infra\main.bicep --validation-level Provider --parameters '@C:\Private\kuma\preview.parameters.json' appLocation=westus2 databaseLocation=westus2
# Only after reviewing the preview and receiving live-creation approval:
az deployment group create --resource-group <approved-group> --template-file .\infra\main.bicep --parameters '@C:\Private\kuma\deployment.parameters.json' appLocation=westus2 databaseLocation=westus2 --output none
```

Required parameters: `name`, `image` (the anonymously pullable GHCR digest),
`operatorIPv4` (one real public IPv4, never `0.0.0.0`),
`databaseAdministrator`, `databaseAdministratorPassword`, `databasePassword`.
`appLocation` and `databaseLocation` both default to `westus2`. The examples
also explicitly override any stale region values from private parameter files.
A resource group's metadata location does not override either resource location.
Use the West US 2 pilot resource group and fresh globally available names;
do not overwrite manually created resources, reuse old proposal parameters or
assume retained credentials are active. Never adopt the Portal's larger
General Purpose workload default in place of the approved Burstable B1ms.
Obtain actual subscription/resource names only in the private operator context.
Confirm B1/B1ms availability, 20 GiB minimum,
included I/O allowance, default CA trust, billing/credit applicability and budget
notifications before creation. A budget alert is not a hard cap.

Initial app ingress is restricted to that operator IP, including SCM, to avoid
exposing fresh-account setup. The DB allows the app's possible outbound IPs and
one temporary operator IP. Create the scoped user using the privately completed
`infra/database-user.sql` over a MySQL client connection with
`--ssl-mode=VERIFY_IDENTITY`, the server's canonical
`<server>.mysql.database.azure.com` hostname, and current trusted Azure root CAs.
Never use the administrator as the runtime user or enable insecure TLS to get
past a startup failure.

After setup/import and private verification, the parent can remove the app's
initial ingress restriction to publish the intended status service and remove
the temporary DB operator firewall rule. Preserve the app egress rules. Any
future plan/egress change requires checking those rules again.

Parent obtains `appHostname` and `domainVerificationId` privately from the
deployment outputs. For the chosen status subdomain, the user creates its CNAME
to `appHostname` and an `asuid.<subdomain>` TXT containing the verification ID.
After propagation the parent binds the hostname, creates and binds the free
App Service managed certificate, and verifies HTTPS. No placeholder DNS values
are suitable for cutover. No domain bindings or DNS changes are automated here.

## Private configuration tooling

The source inventory was checked privately: six HTTP monitors, one notification,
six notification links, one status page/group, six group links; no tags,
maintenance, parent monitors, proxies, Docker hosts or remote browsers. The
helper deliberately does not implement unused features.

1. Work from a copy of the stopped, complete source directory. Retain the
   untouched archive. Use Python 3.9+ and Node 22+ on the operator machine;
   local Docker is not required.
2. Export with `python .\scripts\export_settings.py C:\Private\kuma\kuma.db C:\Private\kuma\settings.json`.
   The exporter opens SQLite read-only and refuses to overwrite output.
   The manifest contains real credentials and is **secret**. Restrict its ACL
   on Windows; POSIX creation uses mode 0600. It includes a PNG status logo if
   referenced, keeps private HTTP fields, and maps the six associations.
3. Review `manualSettings` privately. Known regenerated DB-migration state and
   JWT secrets are deliberately excluded; other non-general settings are
   included for manual restoration. Set `manualSettingsReviewed` only after
   deciding how each is restored or confirming it is obsolete. Unsupported
   inventory, nondefault unsupported status-page fields or non-PNG upload
   logos fail export instead of being silently dropped.
4. Create a fresh administrator in the restricted destination UI. Import before
   enabling its 2FA, then enroll 2FA separately. Install the helper dependency
   with `npm ci --ignore-scripts`. Set `KUMA_URL`, `KUMA_USERNAME`,
   `KUMA_PASSWORD` in the private process environment, not shell arguments or
   checked-in files. `KUMA_URL` must be HTTPS except loopback testing.
5. Run `node .\scripts\restore-settings.cjs C:\Private\kuma\settings.json C:\Private\kuma\mapping.json`.
   The CLI refuses Actions, a nonempty destination or an existing report.
   It uses the authenticated UI Socket.IO API, not direct MySQL writes.
   It creates the notification before monitors and remaps status-page ordering.
   All monitors remain paused. The private mapping records which were originally
   active for the eventual operator-controlled cutover.
6. On error, inspect the destination privately. Imports are **not transactional**
   across UI API calls. Do not rerun against a partial destination; explicitly
   clean/recreate the disposable pilot only after reviewing what happened.
   Preserve the source and report. Never print manifests or provider credentials.

The helpers do not copy users, sessions, old IDs, history, SQLite schema, or
database migration metadata. They are version-specific internal-UI tooling,
not an upstream-supported universal importer. The full hosted round-trip uses
synthetic data only; the private acceptance comparison is still mandatory.

## Controlled updates (still disabled)

The code is prepared; do not set `ENABLE_AZURE_DEPLOYMENT=true` yet.
After pilot approval and merge to `main`, create a protected GitHub environment
named `production` with required reviewers. Set its nonsecret variables
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
`AZURE_RESOURCE_GROUP`, `AZURE_WEBAPP_NAME`. Configure the Azure federated
credential for `repo:fletchto99/uptime-kuma-azure:environment:production`.
Grant only app stop/start/read and sitecontainer update permissions, plus plan
read permission, scoped to these resources; do not grant Owner or access to
database credentials. Provisioning remains a separate private operation.

Dispatch requires an approved package digest and explicit verified-backup
confirmation. The update script rejects multiple workers and slots, serializes
workflow runs, observes `Stopped` before changing the image, starts once, and
checks the real application's readiness. It never schedules deployments,
creates slots, scales out, or automatically rolls back across schema changes.
The pilot's operator-only ingress will block hosted readiness probes, so this
workflow is for post-cutover updates, not initial setup.

## Configuration-only migration and acceptance

Retain the original verified full-directory backup unchanged and private. Work
from a copy on an approved private operator machine, never a public runner.
The public fixture is not a production importer and accepts no real backup.

Inventory each source configuration field before restoration: six monitors,
notification agent(s) and credentials, monitor/notification relationships,
status-page metadata/groups/order, app settings, tags, maintenance windows,
proxies, remote browsers, Docker hosts/certificates, OAuth/client credentials,
and upload assets if present. Some may not be used; record that explicitly.
Do not infer absence from the public fixture.

Use the released application's UI or the bounded helpers above after confirming
the exact source fields.
These are internal UI APIs, not a promised stable public migration API:

1. Create a new administrator and re-enroll 2FA separately. Do not copy users,
   password hashes, JWT signing secrets, or old sessions blindly.
2. Restore notification configurations and other referenced objects first.
   Preserve credentials privately; record old-to-new IDs.
3. Create monitor groups/parents before child monitors, and create all monitors
   paused. Map notification, parent, proxy, Docker, browser, tag, and maintenance
   references as applicable; never reuse old numeric IDs by coincidence.
4. Restore the status page, its public groups/order, display settings, domains,
   logo and custom CSS; map its monitor IDs. Restore relevant app settings,
   including timezone, retention preferences and entry page.
5. Compare a field-by-field private inventory and counts. Explicitly flag any
   unsupported monitor type/provider or setting; do not omit it. Test a
   notification only with the owner's approval, since that sends a real
   external message. Verify no real monitors are running before cutover.
6. Parent coordinates stopping the source (already stopped per the handoff),
   enabling the replacement monitors once, and verifying polling/notifications.
   User updates DNS only after the parent supplies the actual CNAME target
   and `asuid` verification TXT value. Bind the hostname and managed certificate
   and verify HTTPS before retiring the old endpoint.

Historical records remain available in the private source archive but are not
imported into the fresh service. Six synthetic HTTP monitors do not prove every
actual monitor type or every provider credential; the private inventory and
acceptance check remain mandatory.

## Backup, restore, and rollback acceptance

Managed MySQL point-in-time backups cover the database, not uploaded assets.
App Service automatic snapshots cover the persistent data directory, including
`db-config.json`, without a new storage account. In the pilot, verify the Backups
page actually has a restorable snapshot and test restoration while monitors are
paused. Before each update, freeze configuration/asset changes, wait for an
automatic snapshot newer than the last asset change, and record a matching
restorable DB point within the seven-day DB window. Only then confirm backups
in the update workflow. A blind checkbox is not a backup.

App Service automatic backups are hourly, retained 30 days and not downloadable.
If an immediate/downloadable backup is required, obtain approval for a private
Blob account and on-demand App Service custom backup; this has extra capacity
and transaction charges and uses SAS rather than managed-identity authorization.
MySQL Flexible Server is not included in App Service custom database backups;
keep using its native managed backup. No paid backup service is enabled here.

To recover: stop Kuma, restore MySQL to a new server, restore the matching
assets/config through the App Service Backups restore UI, update private connection settings and
firewall allowlist, then start a single worker using the compatible recorded
image. Keep the failed instance stopped. Verify the restored objects and
notifications before switching traffic. A schema-changing upgrade may require
DB restore as well as an image rollback. Price and approve the temporary restore
server, then separately approve its eventual removal. App Service automatic
restore does not restore custom domains, TLS bindings, identities or networking;
reapply/verify those separately from the retained configuration and IaC. Never
restore into a running slot or leave a second restored monitor app active.

For initial cutover rollback, stop the replacement before asking the parent to
restore/restart the original service or reverse DNS. This branch must never
operate on or delete the original VM.
