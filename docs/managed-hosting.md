# Managed hosting readiness

## Pilot deployment runbook

The approved direction is App Service B1 plus Azure Database for MySQL Flexible
Server B1ms, using MySQL 8.4 LTS. The approved migration scope is configuration
only, not historical heartbeats or uptime records. No alternative platform,
SQLite synchronization service, or self-managed database is proposed here.

**Current target: West US 3 for App Service, West US 2 for MySQL and the resource
group.** Paid provisioning requires successful full Provider preflight and explicit
release. Previous Central US, West Central US, all-West US 2 and East US 2 proposals are inactive; retain
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

`infra/main.bicep` compiles offline. Provisioning is separate from the controlled
update workflow; there is no registry webhook or scheduled infrastructure deploy.
Automatic updates require the explicit repository activation switch below.
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

Selected split-region CAD retail estimates, at 730 hours/month, before taxes:

| Component | Assumption | Estimated CAD/month |
| --- | --- | ---: |
| Linux App Service plan | West US 3 B1, one worker, CAD0.023864/hour | 17.42072 |
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
- **Traffic:** the West US 3 app connects to the West US 2 database over
  certificate- and hostname-verified TLS. Cross-region outgoing traffic is
  currently CAD0.0281/GB in each direction; count requests and responses
  separately, not the same transfer twice. Incoming traffic is free. Internet
  egress and other applicable network charges remain additional. Actual volume
  and database latency are unmeasured; HTTP probes originate from West US 3.
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
   routing. Startup sets Node's `process.umask(0o077)` before loading the stock
   server, without shell quoting that App Service's startup parser can split.
   New runtime secret files therefore retain the restrictive process umask.
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
5. The controlled Actions update uses OIDC and a main-only deployment
   environment. Scope the federated identity to the repository/environment and
   minimum Azure deployment permissions. Tenant/subscription/client IDs are
   nonsecret identifiers, but stay out of public source/logs per the user's
   privacy requirement. Store them in GitHub environment **Secrets** solely
   for native masking, not because they are long-lived Azure credentials.
   The workflow uses native contexts rather than a privileged variable-loader
   API. Never store a database password or Azure client secret in Actions. Synthetic
   PR CI gets no Azure permission and must never read production secrets.
6. Deploy only an explicitly approved immutable image. Back up the DB and
   assets, stop the app, verify it is stopped, update the image/settings, and
   start once. Verify health and one configured worker. On failure, stop and
   notify the owner; do not leave a half-updated app or automatically run old
   code against a newly migrated schema. No automatic retry of the entire
   deployment or parallel replacement. Azure platform maintenance is outside
   this procedure; no strict distributed exactly-once claim is made.
7. Leave `ENABLE_CONTROLLED_UPDATES` false until the code, scoped OIDC reads and
   same-image deployment verification have passed and activation is approved.
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
az deployment group what-if --resource-group <approved-group> --template-file .\infra\main.bicep --validation-level Provider --parameters '@C:\Private\kuma\preview.parameters.json' appLocation=westus3 databaseLocation=westus2
# Only after reviewing the preview and receiving live-creation approval:
az deployment group create --resource-group <approved-group> --template-file .\infra\main.bicep --parameters '@C:\Private\kuma\deployment.parameters.json' appLocation=westus3 databaseLocation=westus2 --output none
```

Required parameters: `name`, `image` (the anonymously pullable GHCR digest),
`operatorIPv4` (one real public IPv4, never `0.0.0.0`),
`databaseAdministrator`, `databaseAdministratorPassword`, `databasePassword`.
`publicAccess` defaults to `false` for first setup. For an environment whose
main site has already been approved for public access, retain
`publicAccess: true` in its private deployment parameters; otherwise a later
full IaC deployment intentionally reapplies the safe initial restriction.
The image-update workflow doesn't redeploy these access settings.
`appLocation` defaults to `westus3`; `databaseLocation` defaults to `westus2`. The examples
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

Initial main-site ingress is restricted to that operator IP to avoid exposing
fresh-account setup. SCM has its own explicit operator allow rule and deny
default, with `scmIpSecurityRestrictionsUseMain: false` in both initial and
public modes. The DB allows the app's possible outbound IPs and
one temporary operator IP. Create the scoped user using the privately completed
`infra/database-user.sql` over a MySQL client connection with
`--ssl-mode=VERIFY_IDENTITY`, the server's canonical
`<server>.mysql.database.azure.com` hostname, and current trusted Azure root CAs.
Never use the administrator as the runtime user or enable insecure TLS to get
past a startup failure.

After setup/import, verify that unauthenticated protected Kuma API calls are
denied, then obtain explicit approval before setting `publicAccess: true`.
This changes only the main-site policy to allow public traffic; it does not
disable Kuma authentication, open SCM, or modify MySQL firewall rules.
Recommend 2FA, but don't silently enable it or change the user's password.
Keep the approved public setting in the active private parameters and verify
custom HTTPS and SCM isolation afterward. Removing the temporary DB operator
rule is a separate operation; preserve it unless that removal is approved.
Future plan/egress changes require checking the DB allowlist again.

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
   The importer regenerates the first-login timezone marker using the source's
   explicit timezone, so a later browser login cannot silently replace it.
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

## Controlled updates

The pipeline is deterministic GitHub Actions, not an AI agent or runtime
controller. It uses the existing managed services and public image package.

1. Weekly Docker-only Dependabot checks run Monday at 10:00 UTC; GitHub scheduling
   is best-effort, not an exact maintenance-time guarantee. Major updates are
   ignored by Dependabot and require a separate manual change.
2. PR CI has no Azure access. It checks the readable tag/index digest, exact
   upstream TLS-patch source guards, actual app/MySQL/TLS cases, configuration
   migration, policy tests, shell lint and Bicep.
3. `dependabot-merge.yml` runs trusted **main** code after successful PR CI.
   It verifies the real Dependabot bot identity, same-repository Docker branch,
   current head and base, successful expected workflow/job, and exactly one
   modified Dockerfile. Only the first pinned upstream `FROM` line may change.
   Downgrades, major versions, forks, extra files and changed patch logic are
   refused. Native strict required checks remain the final merge gate.
4. The workflow merges the exact verified head using REST, then explicitly
   dispatches `deploy.yml` with the resulting main SHA. `GITHUB_TOKEN` merges
   normally suppress push-triggered Actions; the explicit dispatch avoids
   relying on that suppressed event. A failed dispatch is a visible workflow
   failure requiring operator attention, never a claimed deployment.
5. A release re-runs trusted main CI through the reusable compatibility workflow,
   publishes the image and passes its exact digest to the deployment job.
   Main is checked again before changes; a stale request fails before stopping
   the app. Feature/PR builds cannot deploy or obtain production secrets.
6. A native recovery gate runs before stop/update/start. The deployment changes
   only the existing main container image and preserves the startup command,
   custom certificate, public-main/private-SCM policy, settings and monitor data.
   One production concurrency group serializes updates with cancellation off.

### Identity, integration and activation

Create the `production` environment with only the `main` branch allowed.
Unattended operation cannot require a human approval on every deployment; the
user approves the policy before activation instead. Main requires the trusted
`mysql-tls` GitHub Actions check with strict up-to-date checks, no force pushes
and no deletion. No administrator bypass or force merge is used. Major and
source-guard changes remain manual because the merger refuses them, not because
it invents a passing review.

Use a free user-assigned managed identity with a federated credential for
`repo:fletchto99/uptime-kuma-azure:environment:production`, issuer
`https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`. Do not attach the identity to Kuma.
Assign the custom updater role only on the existing app, its plan and its
MySQL server. Required actions are app read/start/stop, sitecontainer read/write,
slot/snapshot read, plan read, database metadata read and native backup read.
No subscription Contributor, database data-plane rights, credential-list action
or permission to create a restored server is needed.

Environment Secrets contain these **nonsecret identifiers**, masked by GitHub:
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
`AZURE_RESOURCE_GROUP`, `AZURE_WEBAPP_NAME`, `AZURE_MYSQL_SERVER_NAME`.
No GitHub PAT, app private key or Azure client secret is introduced.

After hosted CI passes and main integration is approved, dispatch
`Controlled Kuma update` with `operation=verify` and the expected main SHA.
This proves actual `GITHUB_TOKEN` environment access, OIDC login, scoped native
metadata reads and the recovery gate without changing the app. Then the approved
`operation=noop` performs one same-live-digest stop/start to prove write
permissions and readiness. Only after both pass, set the repository variable
`ENABLE_CONTROLLED_UPDATES=true`. The release operation and automatic merger
remain disabled otherwise. No-op/verify dispatches still require main and the
configured production environment.

Eligibility and event-suppression handling are unit-tested; don't create fake
Dependabot PRs or synthetic production incidents to claim live merging is proven.
The first real eligible update exercises the real merge-to-release path.

### Native recovery gate and failure reporting

The unattended gate replaces the old manual `backups_verified` input. It requires
a Ready database with at least seven-day retention, a completed native full
backup no older than 26 hours, and an App Service snapshot:

- No older than six hours and at least 15 minutes old.
- Within the database's advertised earliest-restore boundary.
- At or after one of those completed full backups, allowing native log replay.

The same snapshot timestamp is recorded as the intended database PITR time.
Azure's server metadata does not expose a guaranteed latest restorable timestamp;
the 15-minute lag is a conservative allowance for log upload, not proof of
replay completeness. These are **metadata-compatible recovery references, not
a restore drill or cross-store transaction-consistency proof**. If the metadata
gate fails, no app update starts. Do not change assets/configuration around an
update; confirm a recoverable matching pair when making significant changes.

The 30-day `recovery-metadata` Actions artifact contains only UTC timestamps,
public image digests and source commit. No Azure identifiers, credentials,
hostnames or private configuration are uploaded. To recover, the operator uses
the privately held app/database identifiers to find the exact snapshot timestamp
and restore MySQL to the recorded time. A snapshot older than the seven-day
database window may no longer form a recoverable pair even if its artifact remains.

Actual deployment failure writes a marker only after stop/update/start begins,
attempts to leave the app stopped, and opens or updates one bot-owned incident
issue. The issue contains the run link and recovery instructions, not Azure IDs
or secrets. Backup/preflight failures don't create fake outage issues. GitHub
Actions failure notifications and the issue mention are independent of Kuma;
the owner must enable appropriate GitHub notifications. Email receipt is not
verified or guaranteed.

The script rejects multiple workers and slots, observes `Stopped`, changes the
exact image, starts once and checks its own HTTP startup-readiness response.
It does not poll monitored targets or treat a target DOWN as a deployment failure.
This one-time response check is **not** continuous database-aware liveness,
App Service Health Check, or automatic runtime recovery.
Initial operator-only main ingress blocks hosted readiness probes. After the
explicit public-access decision, probes use the public main hostname while
SCM remains operator-only; this workflow is not for initial setup.

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
paused. Keep configuration/asset changes outside update windows, retain native
snapshots and the private source archive, and use the recovery gate above.
A passing metadata check is not proof that an arbitrary combination of files
and database state has been restored successfully.

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

The original VM has been retired. Do not plan to restart it for rollback.
Recovery uses retained private archives and native backups, with any new paid
restore resources separately approved. Never overwrite the original archive.
