# Falco Factory 1.7.0 validation

Validation platform: Windows, Node.js **26.13.0**, pinned Wrangler **4.166.0**. The supported minimum remains Node.js 22.12.0; this run did not separately test the minimum runtime.

## Automated checks

- `npm.cmd test`: **183 passed**, zero failures, skips, or cancellations. Includes the existing regression suite and 24 connection tests.
- `npm.cmd run test:browser`: Studio, keyboard/mobile behavior, client actions, privacy, and browser-managed shutdown passed with installed Microsoft Edge through `FALCO_CHROMIUM`.
- `npm.cmd run test:connections-browser`: connection OAuth jobs, account hierarchy, required multiple-account selection, generation/persistence, remote profile routing, local reassignment, reauthentication, browser response token exclusion, and mobile layout passed.
- The authentication service is exercised through injected Wrangler fixtures and actual Node child processes with independent working directories/environments. CI requires no Cloudflare credentials.
- Tests cover official create/list/activate/delete commands, reauthentication, profile-specific identity/token inspection, account mismatch, unavailable profiles, secure-storage enforcement, environment and `.env` token overrides, legacy API Tokens, simultaneous sessions and project deployments, Workers listing/deletion, frontend bindings, KV provisioning/publishing, staged versions/promotion/rollback, secret rotation, project generation/import/reassignment, local token protection, and sanitized history.

## Live read-only authentication checks

Both `npm.cmd run falco:auth:status` and `npm.cmd run falco:auth:secure` passed against the existing default login with OS credential access outside the workspace sandbox. Wrangler reported encrypted OAuth storage using **Windows Credential Manager**. Account discovery and Workers read access passed. The secure command detected existing secure storage and did not start a replacement login. No credential values were returned in the reports or copied into the release.

Deployment and KV write permissions were correctly reported as **not tested**. No Worker was deployed, changed, deleted, or rolled back in the live account, and no paid provider request was made.

## Native release verification

Packaged release verification passed with **202 files**. The Windows C# launcher is rebuilt with assembly/file version **1.7.0.0**. The release verifier extracts the generated ZIP into an isolated temporary folder, checks required files and credential exclusions, runs its native EXE dependency check, and starts **EXE → original main.cmd → packaged Studio** on an available loopback port. It checks the packaged connection UI, rejects an invalid profile path, and verifies that closing the last browser tab stops the native launcher cleanly. Installed pinned dependencies are reused through a temporary junction; `node_modules` is not distributed in the ZIP.

Reproduce after `npm.cmd run release` with `npm.cmd run test:release`. Set `FALCO_CHROMIUM` to an installed Chromium browser executable when Playwright's downloaded browser is unavailable.

## Remaining live verification

Creating and reauthenticating additional real Cloudflare identities requires the intended users to approve browser OAuth. Those paths were tested with injected Wrangler processes, including real child-process isolation and browser/server integration; this validation did not authorize new live identities. Before production deployment, verify a named connection and run the desired deployment against an explicitly selected staging account. Actual deployment/KV write capability is only established by those authorized writes.

Wrangler profiles are experimental. The isolated adapter intentionally fails on an unexpected list format and keeps Wrangler pinned. External manual binding/profile edits during Factory work are outside its coordination; Factory pins each inspection process to its intended profile and blocks fallback. A stale auth lock after a crash requires confirming that its owning operation has stopped before clearing it. Additional non-Factory account-specific bindings require an explicit resource migration when retargeting a project.
