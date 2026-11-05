# Uptime Kuma on Azure

A prototype for running Uptime Kuma on Azure Container Apps while retaining SQLite
and persisting database changes to Azure Blob Storage with Litestream.

The goals are managed hosting without a host OS to maintain, a custom HTTPS
domain, controlled container updates, and low running costs.

This repository is under development. Deployment and automatic updates are not
enabled. Database backups, credentials, and private configuration must never be
committed to this repository or included in container images.
