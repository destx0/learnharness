<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# No guessing

All design authority belongs to the human. **Never guess a design or implementation decision.** If anything is ambiguous — naming, behavior, data shapes, UX, defaults, scope boundaries, prompt wording — STOP and ask with the ask-user-question tool before proceeding. If you are "a little unsure," you are unsure: ask. A wrong guess is far more expensive than a question. Ask early, ask specific, one question per call.

Concretely: first investigate and plan rigorously (asking the user design questions along the way), get the plan approved by the user, and only then implement. Implementation should be mechanical execution of an approved plan — not interpretation.

<!-- LOCAL-ONLY (destx0 fork, this machine): delete this section if merging upstream. -->

## Deploying to the local server (this machine)

This checkout is not a desktop-only build: it is also served at
`http://127.0.0.1:3100` by the user unit `learnharness.service`, which runs
`.next/standalone/server.js`. A change is only "done" when it is deployed there.

```bash
bash scripts/deploy-local.sh              # typecheck, tests, build, restart, health check
bash scripts/deploy-local.sh --skip-tests # same without the ~45s test suite
bash scripts/deploy-local.sh --rollback   # restore the last good payload
```

Exit 0 means HTTP 200 on `/` after the restart. `next build` alone is NOT a
deploy — `scripts/build-server.mjs` must run too (static assets, plugin payload,
runtime-read prompt assets, and the guards that keep `data/` and provider
credentials out of the bundle). Details: `docs/local-deploy.md`.

Commit your work before deploying so the running build matches a commit, and
never leave the server serving a build that does not correspond to HEAD.

