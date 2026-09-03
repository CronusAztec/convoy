## Live VPS access (no password needed)

This container has a passwordless SSH deploy key trusted by the production VPS
(2.25.184.90 / odoreeci.tech): `deploy/convoy_deploy_key` (gitignored, container-local,
generated once — never ask the human for the VPS password, it is not needed here).

Use `deploy/live-deploy.sh`, which wires the key into the existing scripts automatically:
- `deploy/live-deploy.sh diag` — read-only service status + recent logs (safe default)
- `deploy/live-deploy.sh livetest` — two real WS clients prove realtime works end-to-end
- `deploy/live-deploy.sh update` — build the site tarball and push + restart (site files only)
- `deploy/live-deploy.sh release -- [args]` — full `node release.js` pipeline (APK + site)

`update`/`release` restart the live convoy service serving real riders — read DEPLOY.md
before running either, and prefer `diag`/`livetest` first to check current state.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
