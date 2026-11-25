# Cloudflare connections in Falco Studio

Falco Factory 1.7.0 lets each local project use its own Cloudflare connection and account. You can keep several identities connected at once. Choosing a connection never logs out another identity or changes Wrangler’s global default login.

## Add an identity

1. Open **Falco Studio.exe**. Open **Authentication & permissions → Manage Cloudflare connections** in the sidebar.
2. Choose **Add Cloudflare connection** and enter a friendly name, such as **GTL AI**. Confirm its profile name, such as `gtl-ai`. Profile names use letters, digits, underscores and hyphens; they cannot begin with a hyphen. `default` and `staging` are reserved.
3. Choose **Connect in browser**. Studio starts Wrangler’s official OAuth flow and opens your default browser. Sign in to the desired Cloudflare identity and authorize the accounts you need. The connection name does not determine which browser identity is signed in: check the identity shown by Cloudflare before approving.
4. Return to Studio. The progress indicator stays active until authentication and encrypted OS storage have been verified. The connection card then shows accessible accounts and its last successful verification.

If the browser does not open, cancel and retry after checking the default browser. Allow the Cloudflare authorization page and its localhost callback. Only one OAuth flow can run at a time because Wrangler uses a shared callback port. Canceling stops the local flow; if authorization already completed, verify the connection to determine its outcome. A canceled reauthentication does not delete the connection or its project assignments.

## Select a project’s destination

In **Create new → Launch Worker**, choose a **Cloudflare connection** and **Deployment account**. Multiple accounts require an explicit selection. Review the destination before choosing **Deploy**. Generate-only also saves the connection and account, without deploying.

The project stores only its profile reference in `.falco-generated.json`. Its existing `account_id` remains in `wrangler.json`. Credentials never belong in either file. CLI users can also supply `--auth-profile NAME --account-id ID`.

In **Manage Workers**, choose a connection first, then an account. Worker discovery, chat URL discovery, frontend export, source linking, and remote deletion retain that exact connection/account pair. Access to the same account through two identities does not merge their selection. A local project associated with another connection must be changed explicitly before it is linked through the new identity.

To edit a saved assignment, load the local project and open **Change project connection or account**. Choose the connection and account, then **Verify & save connection**. Saving performs no deployment. If a remote refresh fails, Studio labels the editor as saved local configuration; authenticated deployment and remote-state safeguards still apply.

Changing profiles within the same account preserves the deployment baseline after checking it with the new identity. Changing accounts requires the exact Worker name and an explicit warning acknowledgment. Factory checks the old tracked deployment and refuses an occupied destination Worker name. The old Worker, deployments, secrets, and KV data stay in the old account. Factory backs up local files, clears the old deployment/KV/staged baseline, and removes the old Factory knowledge namespace binding. A future deployment creates resources in the new account; provider secrets must be supplied for that new deployment. Projects with additional account-specific bindings require a deliberate migration, usually through a clone.

## Reauthenticate or recover an expired connection

Use **Reauthenticate** on the existing connection card. Approve authorization in the browser and verify the refreshed account list. Factory uses the same profile name, so project references remain valid. It does not delete the profile first or log out other identities.

**Verify** checks authentication, credential storage, accessible accounts, and Workers read access when an account is selected. **Manage** edits the friendly name and optional default account. A default is descriptive convenience; creating a project with several available accounts still requires an explicit choice.

Write permissions remain **untested** until the requested deployment or KV write actually runs. A successful Worker listing does not prove deployment or KV write permission.

## Secure storage

Factory forces `CLOUDFLARE_AUTH_USE_KEYRING=true` for named OAuth operations. On Windows, Wrangler keeps encrypted OAuth credentials in its own encrypted file and the encryption key in Windows Credential Manager. Factory verifies Wrangler’s storage report before allowing named-profile sessions. If the backend is unavailable or storage cannot be verified, the operation stops; Factory never silently chooses plaintext storage.

Wrangler owns credential storage and refresh. Factory holds a resolved API credential only in server process memory for direct Cloudflare requests. It does not return that credential to Studio, save it in project metadata, or put it in operation history. Account IDs are masked on cards, with **Copy ID** available; account IDs are identifiers, not authentication credentials.

Factory’s non-secret connection names/defaults/verification times are stored in `.falco-connections.json` in the installation directory. Stable profile inspection contexts are under `%USERPROFILE%\.falco-factory\contexts\PROFILE`. These directories contain no Factory-managed credentials. Factory establishes their bindings using Wrangler’s official `auth activate` command. Project deployment commands select the profile explicitly. Inspection processes also pin Wrangler?s native profile environment selector to prevent a removed binding from resolving to the default profile. The shared registry lock protects Factory binding changes across processes, while separate child environments prevent project routing from leaking across concurrent operations.

The Studio server remains bound to `127.0.0.1`; connection changes require Studio’s local request token. Browser requests cannot choose an authentication directory or an executable. Avoid manually changing Wrangler directory bindings or deleting profiles while Factory operations are running.

## Environment API tokens and legacy projects

An inherited `CLOUDFLARE_API_TOKEN` takes precedence over OAuth profiles. Factory blocks a named connection when an environment token, API key/email, authentication headers in `CLOUDFLARE_API_HEADERS`, or their legacy `CF_*` aliases would override it, and explains how to recover. Project `.env` and `.dev.vars` files containing Cloudflare authentication overrides are also refused for named deployments. Remove those overrides and restart Studio, or explicitly select **Legacy default** to keep using the environment API token. Never paste a token into a connection name, Account ID, or project file.

Existing projects without `authProfile` continue to use **Legacy default** and retain their Account IDs. Factory explicitly resolves the default identity so a directory binding cannot accidentally select a named identity for a legacy project. Existing scoped API Token support remains available through this legacy selection. Global API Key/email authentication remains unsupported.

For terminal-based legacy recovery, `npm.cmd run falco:auth:status` reports safe diagnostics and `npm.cmd run falco:auth:secure` verifies or starts Wrangler’s secure default OAuth flow. Ordinary Studio OAuth uses the connection card and does not require PowerShell.

## Troubleshoot access errors

| Studio status or error | Recovery |
| --- | --- |
| Authentication expired / HTTP 401 | Reauthenticate the existing connection. Check connectivity if OAuth refresh could not reach Cloudflare. |
| Account not accessible | Select an account listed for that identity. Reauthenticate and authorize the missing account if necessary. Factory does not try another identity. |
| HTTP 403 on Workers listing | Confirm the account belongs to the chosen connection. If it is listed, check Workers Scripts read permission and the identity’s account role. |
| HTTP 403 on deployment | Confirm the account, Workers Scripts write permission, and permissions required by its bindings. Listing alone does not verify writes. |
| HTTP 403 on KV | Confirm KV read/write permission and that the namespace belongs to the selected account. |
| Environment token overrides profiles | Remove Cloudflare authentication overrides from the launcher environment and project environment files; restart Studio. Or explicitly use Legacy default. |
| Secure storage unavailable | Check Windows Credential Manager, the current Windows user session, and Wrangler’s ability to install/load its keyring binding; reauthenticate after repairing it. Never assume that an unknown storage report is secure. |
| Wrangler profile unavailable | Restore that exact profile name through reauthentication, or explicitly change each affected project’s connection. |
| Profile listing format changed | Reinstall the pinned Wrangler **4.166.0**. Profiles are experimental; update Factory’s isolated adapter before changing Wrangler versions. |
| Authentication already running / lock remains after a crash | Finish the other login first. If all Factory/Wrangler operations have stopped after a crash, inspect the corresponding `.falco-lock` under `%USERPROFILE%\.falco-factory` before removing a stale lock. Never remove a live operation’s lock. |

## Remove a connection safely

Choose **Delete connection** on its card. Studio lists assigned local projects and requires confirmation plus the profile name. The list is checked again before deletion. Wrangler removes only the local profile and its directory bindings. Factory retains local projects and their profile assignments. It does not delete Cloudflare accounts, Workers, KV namespaces, deployments, or secrets, and does not reassign projects to another identity.

To reconnect those projects later, add the same profile name again or explicitly verify and save a different connection for each project. Projects in other Factory installations may also reference the profile; review those installations before deleting a shared Wrangler profile.

Official references: [authentication profiles](https://developers.cloudflare.com/workers/wrangler/profiles/) and [Wrangler authentication commands and secure storage](https://developers.cloudflare.com/workers/wrangler/commands/general/). The adapter is verified against the actual bundled Wrangler 4.166.0 command implementation, including commands that reject `--profile`.
