# v0.6 — Neutral Frontend Integration Kit

## New

- **Export frontend kit ↓** button on every supported Falco Worker in **Manage existing**.
- Auto-injects the selected Worker's public `workers.dev` `/chat` endpoint.
- Generates universal vanilla HTML/CSS/JS with a standalone, framework-free transport module.
- Fully design-neutral, no Shadow DOM, easy to restyle and restructure.
- `AGENT_GUIDE.md`, `API_CONTRACT.md`, `README.md` hand off workflow to the web-design agent.
- No external zip library or frontend build tools.
- Same-origin static demo server with Node.js.
- No provider key, Worker code, secret or deploy action in the ZIP export.

## Unchanged

Worker generation and deployment; one-click Load Worker; exact confirmed Delete; knowledge editor/versioning/restore; Wrangler auth; Cloudflare sync.

## Validated

59/59 Node.js tests, example ZIP integrity, generated config and module syntax, demo server HTTP 200. Live Worker export and graphical browser demo still require verification on the user's PC.
