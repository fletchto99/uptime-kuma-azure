# Uptime Kuma on managed Azure services

Candidate: Linux App Service B1 and Azure Database for MySQL Flexible Server B1ms,
using stock released Uptime Kuma. No VM, Litestream, paid container registry,
or custom persistence controller.

**Deployment tooling; live operation requires explicit approval.** The compatibility
workflow runs disposable synthetic containers, compiles Bicep, and checks update
guards without Azure credentials. A separate manual OIDC update workflow is
disabled until deliberately enabled, restricted to `main`, and requires backup
confirmation and a protected environment.

`publicAccess` defaults to `false` for initial setup. After explicit approval,
set it to `true` in the environment's private parameters to publish the main
site without changing Kuma authentication. SCM keeps its own operator-only
allow rule and deny default; it never inherits public main-site access.

The selected deployment places **App Service in West US 3 and MySQL in West US 2**,
in a West US 2 resource group. Paid provisioning requires a successful full preflight
and explicit release; earlier regional proposals are historical, not active
deployment instructions.

The Dockerfile pins the official readable release tag and multi-platform index.
It applies a narrow, user-approved TLS hostname-verification patch: stock 2.5.9
trusts the CA but does not check the database hostname. Full-file SHA256 guards
make upstream source changes fail visibly. The app is not rebuilt or forked.
Only that public patch enters the build context.

Weekly Docker-only Dependabot updates can propose changes after this
configuration reaches the default branch. An update that changes either patch
target requires reviewing the source and guards. Remove the patch when upstream
sets `verifyIdentity: true` for all database connection paths, then rerun the
actual-app certificate tests. Never disable a negative test to get an update
through. Auto-merge and scheduled deployments remain off.

## Compatibility gate

`tests/compatibility.sh` tests the patched official image against MySQL 8.4.9:

- Actual schema initialization and application startup using the stock release.
- TLS encryption and rejection of an untrusted CA.
- Rejection of a trusted certificate with the wrong hostname during actual
  application startup.
- An explicit `verifyIdentity: true` driver control to distinguish a broken
  test fixture from missing application hostname verification.
- A stopped synthetic SQLite database exported privately and restored through
  Kuma's authenticated UI API into its own MySQL schema, with remapped IDs,
  credentials, status-page order and settings checked.

Passing trusted-branch CI publishes a generic credential-free amd64 image to
GHCR and verifies anonymous pull access. Production uses its immutable digest,
not the mutable tag. A successful Community MySQL test does not replace the
approved Azure pilot.

## Migration boundary

The user approved a fresh database and configuration-only migration; historical
heartbeats and uptime records need not be imported. The original verified
full-directory archive remains intact for rollback and historical reference.
The bounded helpers support the verified source inventory: six HTTP monitors,
one notification, one status page/group, and no tags, maintenance, proxies,
Docker hosts or browser references. They reject unsupported inventory, create
notifications before paused monitors, remap references and status-page order,
and report settings that need manual review. Create a fresh administrator
separately. See the [private migration procedure](docs/managed-hosting.md).

No source backup or private configuration may be placed in this repository,
image, hosted CI, logs, or artifacts. Kuma writes resolved database credentials
into `db-config.json`; the runtime data directory and its backups are secrets,
even when the initial credentials come from a secret reference.

## Current spending boundary

The selected split-region retail estimate is approximately CAD38.07/month
for West US 3 B1 hosting, West US 2 B1ms MySQL, and the 20 GiB minimum database
storage at 730 hours. Cross-region outgoing traffic is currently CAD0.0281/GB
in each direction, in addition to internet egress and other applicable usage.
Database latency and traffic volume are unmeasured; HTTP probes originate from
West US 3.
CAD50/month is a planning allowance, **not a spending cap**. Taxes, backup
overage, I/O, network egress, asset backups, optional secret-store operations,
and temporary parallel resources can add costs. The web plan waits for successful
database provisioning so a database failure does not leave an unused paid web
worker. Provisioning, DNS, import, and cutover remain separate approval gates.

Start with [the resource, cost, provisioning, update and recovery runbook](docs/managed-hosting.md).
Infrastructure is in `infra/`; private migration and update tools are in
`scripts/`. No command in this README provisions anything.
