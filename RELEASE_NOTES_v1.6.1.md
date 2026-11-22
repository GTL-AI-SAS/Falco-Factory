# Falco Factory v1.6.1 — Secure Wrangler Authentication & Diagnostics

## What changed

- Upgraded the pinned Wrangler CLI from 4.95.0 to **4.166.0**.
- Raised the supported Node.js floor to **22.12.0**, matching Wrangler's current engine requirement.
- Added `npm run falco:auth:secure` / `npm run falco:auth:status` and `falco auth secure|status`.
- `falco auth secure` uses the official `wrangler login --use-keyring` flow. On Windows, Wrangler uses Windows Credential Manager for the encryption key and an AES-256-GCM encrypted OAuth file for credentials.
- Added safe, read-only authentication diagnostics to CLI, `falco doctor --cloud`, and Studio's collapsible **Authentication & permissions** panel.
- Diagnostics report authentication method, credential-storage classification, accounts, and a read-only Workers-list permission check. Deploy and KV write permissions are explicitly marked not tested; no resources are created or changed.
- Tokens, raw Wrangler output, file paths, and account credentials are never returned to the browser.
- The release packager includes a root lockfile only when its Wrangler, Miniflare, Workerd and Undici versions match the pinned release. The Studio visual release includes the verified lockfile and supports clean installs with `npm ci`.
- Existing Falco Worker runtime remains **1.6.0**. This is a Factory/CLI release only; no Worker source is changed or deployed.

## Windows setup

```powershell
npm.cmd ci
npm.cmd run falco:auth:secure
npm.cmd run falco:auth:status
npm.cmd run falco:doctor -- --cloud
npm.cmd test
```

If an OAuth session already exists in Wrangler's plaintext config, Wrangler's opt-in flow migrates it to encrypted storage and removes the plaintext credential file. Review the output of `wrangler whoami` if the diagnostic cannot confirm the backend.

**API Token caveat:** `--use-keyring` protects Wrangler OAuth credentials only. It does not encrypt `CLOUDFLARE_API_TOKEN` environment variables. Protect those separately.

## Permissions and limitations

- The diagnostics verify that the selected account can list Workers. This proves read access only.
- Deployment, secret-write, and KV-write permissions are not tested because a safe diagnostic must not mutate account resources. Cloudflare validates those permissions when the corresponding operation is requested.
- Real Windows Credential Manager behavior and real-account staging deployment must be verified on the target Windows machine; they are not claimed as locally verified in this build environment.

## Validation performed in this build

- Unit tests and syntax checks are run locally.
- No Cloudflare account was authenticated, no live Worker was changed, and no staging deployment was performed.
- The GitHub release workflow runs Windows and Linux jobs and includes clean ZIP extraction checks.
