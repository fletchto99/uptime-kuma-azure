# Managed hosting readiness

## Status: blocked before provisioning

The approved direction is App Service B1 plus Azure Database for MySQL Flexible
Server B1ms, using MySQL 8.4 LTS. The approved migration scope is configuration
only, not historical heartbeats or uptime records. No alternative platform,
SQLite synchronization service, or self-managed database is proposed here.

The stock Kuma 2.5.9 compatibility gate found missing TLS hostname verification.
Do not create a deployment around that unresolved requirement. There is no
deployable IaC or deployment workflow in this checkpoint: those were deliberately
deferred rather than presented as working. The Dockerfile and read-only hosted
test are safe to review independently.

## Evidence and limits

[Hosted run on 2026-11-05](https://github.com/fletchto99/uptime-kuma-azure/actions/runs/41982440614)
produced the following results with no Azure resources or private data:

| Check | Result |
| --- | --- |
| Stock Kuma 2.5.9 initializes MySQL 8.4.9 | Pass, 28 tables and application listening |
| Valid CA and matching hostname | Pass, TLS cipher in use |
| Untrusted CA | Rejected as required |
| Explicit driver `verifyIdentity: true`, wrong hostname | Rejected as required |
| Actual unmodified Kuma, trusted CA but wrong hostname | **Accepted: deployment blocker** |
| Fresh admin and six paused HTTP monitors via UI API | Pass |
| Notification credential and six remapped associations | Pass |
| Status-page monitor groups/order and app settings | Pass |

The workflow remains intentionally red for the real application hostname
failure. A future corrected release must pass the actual-app check; merely
changing the standalone driver control is not a fix.

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
The tests include an explicit identity-verifying control and then boot the
unmodified app with a mismatched hostname.

## Resources and spending decision

Parent-collected West US CAD retail estimates, at 730 hours/month, before taxes:

| Component | Assumption | Estimated CAD/month |
| --- | --- | ---: |
| Linux App Service plan | B1, one worker, CAD0.025267/hour | 18.44491 |
| MySQL Flexible Server compute | Burstable B1ms, CAD0.030882/hour | 22.54386 |
| MySQL data storage | 20 GiB minimum, CAD0.193717/GiB-month | 3.87434 |
| Core subtotal | No HA or replicas | **44.86311** |

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
- **Assets:** App Service's persistent `/home` uses the filesystem quota already
  included with the plan. No additional Azure Files account is needed for
  runtime files. This is not an independent backup. Private off-app asset
  backups may require a small Azure Blob account, with capacity, transaction,
  redundancy, and retention charges.
- **Secrets:** encrypted App Service settings need no dedicated secret service.
  If a Key Vault reference is selected, price its operations and any retention
  requirements separately; do not claim Key Vault is free.
- **Traffic:** account for internet egress, billable inter-region traffic, and
  applicable service network charges. Keep the two services in the same region.
- **Recovery and migration overlap:** point-in-time recovery creates a new
  billable MySQL server. The old VM and replacement may overlap temporarily;
  original VM deletion remains a separate destructive approval.
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
[MySQL tiers/storage](https://learn.microsoft.com/azure/mysql/flexible-server/concepts-service-tiers-storage).

## Deployment contract after the TLS blocker is resolved

The parent must approve a concrete IaC preview and live resource estimate before
creation. The intended bounded setup is:

1. One Linux B1 plan and one app, one Kuma worker, Always On, HTTPS-only,
   application port 3001. No slots, scale-out, registry webhooks, or rolling
   deployment automation. Validate the contemporary App Service container model
   in the eventual IaC rather than mixing legacy and sidecar settings.
2. One MySQL 8.4 B1ms server, 20 GiB starting storage, local backups, seven-day
   retention, no HA/replicas. Require TLS and restrict public database ingress
   to the app's required outbound addresses plus explicitly approved temporary
   operator access. Do not use the blanket "allow all Azure services" rule.
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
5. Any future Actions deployment uses OIDC and a protected deployment
   environment. Scope the federated identity to the repository/environment and
   minimum Azure deployment permissions. Tenant/subscription/client IDs are
   nonsecret variables, but stay out of public source/logs per the user's
   privacy requirement. No persistent Azure credentials in Actions. Synthetic
   PR CI gets no Azure permission and must never read production secrets.
6. Deploy only an explicitly approved immutable image. Back up the DB and
   assets, stop the app, verify it is stopped, update the image/settings, and
   start once. Verify health and one configured worker. On failure, stop and
   notify the owner; do not leave a half-updated app or automatically run old
   code against a newly migrated schema. No automatic retry of the entire
   deployment or parallel replacement. Azure platform maintenance is outside
   this procedure; no strict distributed exactly-once claim is made.
7. Leave manual deployment dispatch, scheduling, and auto-merge disabled until
   the pilot is explicitly released. Dependabot only proposes Docker updates.
   Public CI failures notify through GitHub Actions subscriptions; confirm the
   owner's delivery settings. Future deployment must have an explicit failure
   notification path before it is enabled.

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

Use the released application's UI for this small installation, or its
authenticated Socket.IO calls only after confirming the exact source fields.
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
Before each update, record a restorable DB point and take an independent private
backup of the data directory. Protect and restrict those backups like passwords,
including copies of `db-config.json`. Test retrieving both before cutover;
do not assume filesystem persistence equals a backup.

To recover: stop Kuma, restore MySQL to a new server, restore the matching
assets/config, update the private connection settings (hostname/secret reference) and
firewall allowlist, then start a single worker using the compatible recorded
image. Keep the failed instance stopped. Verify the restored objects and
notifications before switching traffic. A schema-changing upgrade may require
DB restore as well as an image rollback. Price and approve the temporary restore
server, then separately approve its eventual removal.

For initial cutover rollback, stop the replacement before asking the parent to
restore/restart the original service or reverse DNS. This branch must never
operate on or delete the original VM.
