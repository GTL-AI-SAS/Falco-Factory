# Falco Factory Studio v0.5 — Release notes

- Added **Load Worker ↗** beside every remotely discovered Falco Worker.
- Load searches for a matching previous `.generated/<name>` project in nearby Factory installations and Windows Downloads. It checks remote membership, Worker name and Cloudflare account before importing and opens the editor with one click.
- Added **Delete** beside every remotely discovered Falco Worker. Requires a typed exact Worker name plus a second confirmation, and uses Cloudflare's official delete endpoint with Wrangler-provided credentials.
- Deletion preserves local source, prevents concurrent destructive operations, and refreshes the remote list.
- Existing safeguards stay in place: loopback-only server, CSRF token, no API keys in the browser response, knowledge snapshots, rate-limited Workers and safe deploy.
- Fall back to manual linking only when no verifiable local source can be found. Remote bundled Worker scripts are not reverse-engineered into editable source.
- **53 Node.js automated tests passed**, including 8 new lifecycle tests. Browser UI checked with simulated Cloudflare responses.
- Cloudflare live deletion was intentionally NOT performed when building this release.
