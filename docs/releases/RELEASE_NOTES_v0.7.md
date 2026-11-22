# v0.7 — Multi-Origin CORS + Verified Frontend Kit Metadata

- **Create new Falco:** multiple site origins in the same textarea, one exact URL per line.
- **Manage existing:** update allowed origins without changing instructions or FAQ; the Worker URL/provider/secrets are retained. Safe local snapshot before Wrangler redeploy.
- **Legacy compatibility:** recognized old `ALLOWED_ORIGIN` runtime is upgraded to support the JSON `ALLOWED_ORIGINS` allowlist on the first origins update. Unknown custom CORS source is not overwritten.
- **Export frontend kit:** queries Cloudflare's *deployed* Worker bindings, not local guesses, for its allowed origins. Adds `ALLOWED_ORIGINS.json` and `ALLOWED_ORIGINS.md`, includes list in README; export fails if verification is unavailable.
- **Security:** `Origin: null`, wildcards, remote HTTP, duplicate origins, paths and credentials are rejected. Existing rate limiter remains active. CORS is not authorization against nonbrowser clients.
- **History:** new snapshots save origins too; Restore can reinstate an earlier allowlist. Previous snapshots lacking an array fall back to their saved legacy `origin`.
- **Testing:** local suite, mock Cloudflare endpoints, Worker preflight tests, old-Worker upgrade/restore and ZIP inspection. Live Cloudflare deploy not executed here.
