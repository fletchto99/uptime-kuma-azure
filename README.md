# Uptime Kuma on managed Azure services

Candidate: Linux App Service B1 and Azure Database for MySQL Flexible Server B1ms,
using stock released Uptime Kuma. No VM, Litestream, paid container registry,
or custom persistence controller.

**Not deployable yet.** The compatibility workflow is a blocking gate, not a
deployment workflow. It runs only disposable synthetic containers on
GitHub-hosted runners; it has no Azure credentials or deployment permissions.
Stock Kuma 2.5.9 starts on MySQL 8.4.9 but accepts a trusted certificate for
the wrong hostname. See [readiness, costs, and migration boundaries](docs/managed-hosting.md)
before considering live provisioning.

The Dockerfile contains only the upstream readable version tag and verified
multi-platform index digest. Weekly Docker-only Dependabot updates can propose
changes after this configuration reaches the default branch. Auto-merge,
scheduled deployments, and App Service continuous deployment are not enabled.
No custom application build or private files are included in the image.

## Compatibility gate

`tests/compatibility.sh` tests the pinned stock image against MySQL 8.4.9:

- Actual schema initialization and application startup using the stock release.
- TLS encryption and rejection of an untrusted CA.
- Rejection of a trusted certificate with the wrong hostname, including both
  the bundled driver and actual application startup.
- An explicit `verifyIdentity: true` driver control to distinguish a broken
  test fixture from missing application hostname verification.

The workflow deliberately fails if any required protection is missing.
It must not be made green by disabling certificate checks or by ignoring
hostname-check failures. A successful Community MySQL test still does not
replace a subsequently approved Azure pilot.

## Migration boundary

The user approved a fresh database and configuration-only migration; historical
heartbeats and uptime records need not be imported. The original verified
full-directory archive remains intact for rollback and historical reference.
Recreate notifications and other referenced objects before monitors, map their
IDs, restore monitor-to-notification links, then restore status-page groups and
app settings. Create an administrator separately. Do not silently drop private
notification credentials or unsupported configuration fields.

No source backup or private configuration may be placed in this repository,
image, hosted CI, logs, or artifacts. Kuma writes resolved database credentials
into `db-config.json`; the runtime data directory and its backups are secrets,
even when the initial credentials come from a secret reference.

## Current spending boundary

The parent session's West US retail estimate is approximately CAD44.86/month
for B1 hosting, B1ms MySQL, and the 20 GiB minimum database storage at 730 hours.
CAD50/month is a planning allowance, **not a spending cap**. Taxes, backup
overage, I/O, network egress, asset backups, optional secret-store operations,
and temporary parallel resources can add costs. No paid resources have been
created. Provisioning, DNS, import, and cutover remain separate approval gates.
