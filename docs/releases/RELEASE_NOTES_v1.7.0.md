# Falco Factory 1.7.0 — Cloudflare Connection Manager

Studio now manages multiple Cloudflare OAuth identities through Wrangler’s official named profiles. Connections can be created, verified, renamed, reauthenticated, and removed without manually running authentication commands. OAuth runs asynchronously with progress and cancellation. Connection cards show storage, accounts, identity, verification time, and assigned projects.

Each project retains a connection reference independently of other projects. Deployments, managed updates, version staging/promotion/rollback, secret rotation, KV provisioning/publishing/migration, remote refresh, Worker discovery/deletion, chat endpoint lookup, and frontend export route through that project or selected remote connection. Concurrent project jobs use separate child environments and explicit profile/account targets.

Named OAuth operations require encrypted OS credential storage and block environment credential overrides. Factory keeps only non-secret metadata. Deleting a connection removes local credentials and bindings through Wrangler; it retains remote Cloudflare resources and project assignments. Existing default OAuth and API Token workflows remain supported.

Wrangler remains pinned to **4.166.0**. Profile listing and directory bindings are isolated in `lib/cloudflare-auth.mjs`; unsupported identity flags are avoided. `account_id` stays in Wrangler configuration, and the Factory profile reference stays in `.falco-generated.json`.

Account changes verify the selected identity, refuse an occupied destination name, retain the original remote resources, back up local metadata, and clear account-specific Factory state. Additional account-specific bindings require a deliberate resource migration. Staged versions include their profile reference. Saved local configuration remains available if a remote refresh fails, with an explicit warning.

Windows process cancellation now falls back to terminating its own child if `taskkill` starts but is denied. The native launcher accepts validated `--no-open`, `--exit-on-close`, and `--port` options for controlled launches and packaged application verification.

Validation results and live-test boundaries are recorded in [VALIDATION_v1.7.0.md](VALIDATION_v1.7.0.md). See the [connection guide](../CLOUDFLARE_CONNECTIONS.md) and [upgrade instructions](../upgrades/UPGRADE_v1.7.0.md).
