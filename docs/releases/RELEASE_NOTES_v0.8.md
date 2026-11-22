# v0.8 — Reliable one-click site preview handoff

No changes to deployed Workers, AI providers or rate limiting. v0.8 adds a repeatable **integration delivery contract** to every frontend ZIP exported from Studio:

- `LEER_PRIMERO_AGENTE.md`: mandatory checklist; the target site agent must hand over a root-level `ABRIR_DEMO.cmd`, verify the *complete integrated website*, and not rely on `file://` or on testing only the kit.
- `ABRIR_FALCO_KIT.cmd`: ready to double-click to preview the neutral kit over `http://localhost:3000/` on Windows with Node.js 20+.
- `integration/ABRIR_DEMO.cmd` plus `integration/tools/falco-static-server.mjs`: copy-ready starter launcher/server for plain static HTML websites. Files are deliberately separated from the kit demo launcher so integrators cannot confuse the two.
- `AGENT_GUIDE.md` and exported `README.md` reinforce the same mandatory requirement, allowed-origin checks, and production HTTPS requirements.

**CORS remains unchanged:** the Worker must still explicitly allow the local origin (`http://localhost:3000`) for local chat testing and the real published origin for GitHub Pages/Cloudflare Pages. These launchers never authorize an origin by themselves. No `Origin: null` or wildcard bypasses.

Use `ABRIR_FALCO_STUDIO.cmd` to start Factory as before, then **Manage Existing → Export frontend kit** to obtain the new ZIP.
