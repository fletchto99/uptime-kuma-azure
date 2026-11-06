# Uptime Kuma on managed Azure services

Uptime Kuma runs on Linux App Service B1 in West US 3 with Azure Database for
MySQL Flexible Server B1ms in West US 2. The image uses the official release
with source-checked TLS and health-route changes. No VM, Litestream, paid
container registry, or custom persistence controller.

**Operations:** [updates](docs/managed-hosting.md#controlled-updates),
[health and recovery controls](docs/managed-hosting.md#application-health-linux-recovery-and-ssh),
and [backup/restore](docs/managed-hosting.md#backup-restore-and-rollback-acceptance).
Controlled updates use a main-only OIDC workflow and native backup-metadata
gates, not stored Azure passwords.
`ENABLE_CONTROLLED_UPDATES` enables guarded deployments, not automatic merging.

Keep the approved `publicAccess: true` setting in the environment's private
parameters when redeploying infrastructure; the template defaults to restricted
access for fresh setup. SCM keeps its own operator-only allow rule and deny
default, independent of main-site access and Kuma authentication.

Initial provisioning and any new paid recovery resources require their own
preflight and approval; they are not part of routine image updates.

## Image and health

The Dockerfile pins the official readable release tag and multi-platform index.
It applies a narrow, user-approved TLS hostname-verification patch: stock 2.5.9
trusts the CA but does not check the database hostname. Full-file SHA256 guards
make upstream source changes fail visibly. The app is not rebuilt or forked.
Only the public patch and small managed-health module enter the build context.
The source-checked `/healthz` route verifies the application and database with a
bounded, coalesced pooled query and returns only direct 200/503 status JSON.
App Service Health Check and conservative Linux Auto-Heal use it. SCM remains
operator-only, including container terminal access. The requested SSH-disable
flag must be verified separately: the live provider currently omits it on
readback despite accepting the documented update. These controls do not
provide multi-instance HA or guarantee immediate recovery.

## Updates

Docker-only Dependabot checks weekly on Monday at 10:00 UTC (GitHub may delay
scheduled work). **The owner reviews and merges Dependabot PRs** after the
required compatibility CI passes. Nothing automatically approves or merges them.
Every PR and push to `main` runs the full required `mysql-tls` suite, without
file filters, including documentation-only changes. Feature-branch and tag
pushes do not start CI; opening or updating a PR starts one test-only run.
Publishing and deployment remain main-only: every successful current-main push
is eligible for the guarded release. Documentation-only main pushes
intentionally rebuild and can briefly restart Kuma after the existing backup,
identity and health gates pass. Major versions require a separate manual change.
An update that changes any patched source file requires reviewing its guards.
`scripts/patch-managed-hosting.cjs` handles both TLS verification and health-route
registration. Once upstream verifies all database hostnames, remove only the TLS
edits and their guards, retaining the health-route patch and Dockerfile wiring.
Rerun the actual-app certificate tests; never disable a negative test to get an
update through. The workflow never updates source guards automatically.
See [the activation, recovery and failure contract](docs/managed-hosting.md#controlled-updates).

## Compatibility gate

`tests/compatibility.sh` tests the patched official image against MySQL 8.4.9:

- Actual schema initialization and application startup using the stock release.
- TLS encryption and rejection of an untrusted CA.
- Rejection of a trusted certificate with the wrong hostname during actual
  application startup.
- An explicit `verifyIdentity: true` driver control to distinguish a broken
  test fixture from missing application hostname verification.
- Authenticated UI API configuration persisted to MySQL: paused HTTP monitors,
  HTTP fields, notification credentials/links, status-page order and app settings.
- Actual HTTP polling with an UP heartbeat stored in MySQL over verified TLS.
- Actual healthy/DB-disconnected/concurrent health requests, plus timeout,
  coalescing, minimal-response and recovery unit tests. Production is not
  deliberately crashed or disconnected for these tests.

`Kuma tests` (`test.yml`) contains only the required `mysql-tls` job, with no
skipped publication job. It and `Kuma publish` (`publish.yml`) use the same
local compatibility action, so their test suites stay identical.
Manual `Kuma publish` dispatches remain available for explicit test-only
branch validation.

Passing main CI publishes a generic credential-free amd64 image to
GHCR and verifies anonymous pull access. The release reuses the publishing
workflow for final validation/publication before its backup-guarded OIDC deploy.
PRs, feature branches, failed/stale runs and reusable release validations cannot
trigger another release. Production uses its immutable digest,
not the mutable tag. Synthetic Community MySQL checks do not prove live Azure
capacity, firewall configuration, or recovery readiness.

The local unit suite uses Node's built-in test runner: `npm test` (Node 22+).
There are no npm dependencies to install. Container tests use the official
image's bundled clients and run only on disposable GitHub-hosted runners.

## Data and recovery

The one-time configuration migration is complete; its inventory-specific
export/import helpers have been retired. Historical heartbeats remain in the
original private archive. Ongoing recovery uses native MySQL backups and matching
App Service asset snapshots, not a replay of the original import.

No source backup or private configuration may be placed in this repository,
image, hosted CI, logs, or artifacts. Kuma writes resolved database credentials
into `db-config.json`; the runtime data directory and its backups are secrets,
even when the initial credentials come from a secret reference.

## Spending boundary

The initial split-region retail estimate was approximately CAD38.07/month
for West US 3 B1 hosting, West US 2 B1ms MySQL, and the 20 GiB minimum database
storage at 730 hours. The investigated cross-region outgoing rate was CAD0.0281/GB
in each direction, in addition to internet egress and other applicable usage.
Database latency and traffic volume are unmeasured; HTTP probes originate from
West US 3.
CAD50/month is a planning allowance, **not a spending cap**. Taxes, backup
overage, I/O, network egress, asset backups, optional secret-store operations,
and temporary parallel resources can add costs. The web plan waits for successful
database provisioning so a database failure does not leave an unused paid web
worker. Recheck rates and actual usage before making spending decisions.

See the [operations and provisioning runbook](docs/managed-hosting.md).
Infrastructure is in `infra/`; image customization and guarded update tools are in
`scripts/`. No command in this README provisions anything.
