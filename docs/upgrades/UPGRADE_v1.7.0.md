# Upgrade to Falco Factory 1.7.0

1. Finish current operations and close Studio. Keep the original installation as a backup.
2. Extract the complete `GTL_AI_Falco_Factory_v1.7.0.zip`. Keep **Falco Studio.exe**, `main.cmd`, and the application directories together. Node.js 22.12+ is required; first launch installs the pinned dependencies.
3. Open the new **Falco Studio.exe**. Link original project source through Manage Workers, or copy the complete `.generated` directory with Studio stopped. Keep snapshots and deployment/KV metadata with their projects.
4. Existing Wrangler credentials remain in Wrangler’s user storage. Projects without a profile keep Legacy default and their current Account IDs. Profiles already created by Wrangler appear in Connection Manager. Reuse their original names when recovering assignments.
5. To preserve friendly connection names, defaults, and verification timestamps from an earlier 1.7 installation, copy its non-secret `.falco-connections.json` while Studio is stopped. Do not copy credential files into the application or release directory.
6. Add or reauthenticate connections inside **Authentication & permissions → Manage Cloudflare connections**. Assign a project’s connection explicitly before switching identities. Review the deployment target and remote baseline before deploying.

This release does not change the Worker runtime protocol (`1.6.0`) or require an automatic remote deployment. Existing functionality, configuration, knowledge, and provider secrets are preserved. Changing an account is an explicit local retargeting operation, not a transfer of an existing deployment.

See [Cloudflare connections](../CLOUDFLARE_CONNECTIONS.md) for setup, secure storage, account changes, recovery, deletion, and HTTP 403 troubleshooting.
