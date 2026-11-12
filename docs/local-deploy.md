# Local deployment (this machine)

How a source change in this checkout reaches the running app on
`http://127.0.0.1:3100`.

## The pieces

| Piece | Location |
| --- | --- |
| Source checkout | `/home/omu/cud/learnharness` (branch `main`, remote `origin` = upstream, `fork` = destx0) |
| Build output | `.next/` → `.next/standalone/` (Next `output: "standalone"`) |
| Served by | user unit `learnharness.service` → `node .next/standalone/server.js` |
| Data | `LH_DATA_DIR=/home/omu/learnharness-data/data` |
| Keys / auth | `LH_AUTH_FILE=/home/omu/learnharness-data/auth.json` |
| Deploy cache | `~/.cache/learnharness-deploy/standalone.prev` (last good payload) |

The service runs `server.js` from `.next/standalone` with `NODE_ENV=production`,
`PORT=3100`, `HOSTNAME=127.0.0.1`. It does **not** read `src/` at runtime —
everything it needs must be inside `.next/standalone`:

- `server.js` + traced `node_modules` subset → written by `next build`
- `.next/static` and `public/` → copied by `scripts/build-server.mjs`
- `src/agent/prompts/**` and `src/agent/system-prompt.md` → read from disk at
  request time, shipped via `outputFileTracingIncludes` in `next.config.ts` and
  asserted by `build-server.mjs`
- `core-plugins/`, `scripts/plugin-loader.cjs`, plugin-authoring bundle → assembled
  by `build-server.mjs`

So `next build` alone is **not** a deploy: without `build-server.mjs` the app
starts but serves no CSS/JS assets, no plugin payload, and the agents fail to
load their prompts. `build-server.mjs` also refuses to finish if a `data/`
directory, `auth.json`, `.env`, or provider-credential JSON leaked into the
standalone trace — those guards are load-bearing, do not bypass them.

## Deploy

```bash
cd /home/omu/cud/learnharness
bash scripts/deploy-local.sh              # typecheck, tests, build, restart, health check
bash scripts/deploy-local.sh --skip-tests # same, without the ~45s test suite
bash scripts/deploy-local.sh --rollback   # restore the cached last-good payload
```

Exit code 0 means HTTP 200 on `http://127.0.0.1:3100/` after the restart. Any
failure in typecheck, tests, build, `build-server.mjs`, or the health check
restores `~/.cache/learnharness-deploy/standalone.prev` and restarts on it, so
a bad commit does not leave the server down.

Expected downtime: the whole build (2-4 min) — `next build` rewrites `.next` in
place while the old server is still pointed at it. Do not "fix" this by copying
`.next` around; use the script.

## Manual equivalent (if the script is unavailable)

```bash
cd /home/omu/cud/learnharness
npm run typecheck && npm test
npm run build && node scripts/build-server.mjs
systemctl --user restart learnharness
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/
```

## Operate

```bash
systemctl --user status learnharness
journalctl --user -u learnharness -f
systemctl --user restart learnharness
```

## Gotchas

- The unit pins `ExecStart` to `/home/omu/.local/share/mise/installs/node/24.22.0/bin/node`
  while `mise` resolves a different `node` for interactive shells. The build and
  the runtime therefore use different Node minors; if you bump Node, update both
  the unit and re-deploy.
- `npm test` runs the full suite (~2370 tests, ~45s). `--skip-tests` exists for
  iteration speed, not for shipping.
- The service reads data from `~/learnharness-data`, never from the repo — a
  rebuild cannot touch your chats or knowledge graph.
