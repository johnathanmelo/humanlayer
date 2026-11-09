# Fork notes

This checkout is a personal fork of HumanLayer, used to self-host it.

| Remote     | Repository                                                                 | Use                                                    |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| `origin`   | [johnathanmelo/humanlayer](https://github.com/johnathanmelo/humanlayer)    | Your fork. Push and pull here.                         |
| `upstream` | [humanlayer/humanlayer](https://github.com/humanlayer/humanlayer)          | The official repo. Pull updates only; you can't push.  |

Local `main` tracks `origin/main`, so plain `git push` and `git pull` use your fork.

## Get changes from the official repo

Commit or `git stash` your local changes first, then:

```bash
git pull --rebase upstream main     # put your commits on top of the official ones
bun install                         # dependencies may have changed
./scripts/humanlayer-up.sh --restart  # applies new migrations, restarts the app
git push --force-with-lease origin main
```

The push needs `--force-with-lease` because the rebase gives your commits new hashes,
so your fork's `main` no longer matches and a plain `git push` is rejected.
`--force-with-lease` still refuses if the fork has commits you have not pulled.

### If the rebase stops on a conflict

1. Run `git status` to see the conflicting files.
2. Fix each file, then `git add <file>`.
3. Run `git rebase --continue`.

To give up and go back to where you were, run `git rebase --abort`.

## Changes that exist only in this fork

Watch these when you pull from `upstream`:

- `docker-compose.yaml`: MinIO uses Chainguard's images (`cgr.dev/chainguard/minio` and
  `minio-client`), because MinIO stopped publishing community images. If upstream fixes MinIO
  itself, prefer their version.
- `scripts/humanlayer-up.sh`: starts the whole stack with one command
  (`--stop`, `--restart`, `--no-open`).
- Server-side AI calls (task and session titles, task intent, research, design-doc questions,
  next-step extraction) run through your local Claude Code login when `ANTHROPIC_API_KEY` is
  not set. Each call starts one headless `claude` process with no tools, MCP servers, settings
  or saved session, using the `haiku` or `sonnet` alias. Set `HUMANLAYER_AI_PROVIDER=anthropic`
  to go back to the API key, or `=claude-code` to use the login even when a key is set.
  The files involved:
  - `packages/ai/src/providers/claude-code-language-model.ts` (new) and its `.vi.test.ts`
  - `packages/ai/src/providers/models.ts` (picks the primary model, adds `resolvePrimaryModel`)
  - `packages/ai/src/providers/index.ts` (exports `resolvePrimaryModel`)
  - `apps/riptide-api/src/lib/reliable-language-model.ts` (uses `resolvePrimaryModel`)
  - `packages/ai/package.json` and `bun.lock` (adds `@anthropic-ai/claude-agent-sdk`, the
    version the daemon uses)

  If upstream changes the models in `models.ts` or `reliable-language-model.ts`, keep their model
  IDs in the `anthropic(...)` branch. If the daemon upgrades `@anthropic-ai/claude-agent-sdk`,
  bump `packages/ai` to the same version.
- `FORK.md`: this file.

## What is not in git

- `.env` holds the WorkOS keys, the daemon signing keys, and the placeholder values the API
  needs. It is gitignored, so back it up yourself. A fresh clone will not run without it.
- `.devstack.json` is gitignored too. Devstack regenerates it.
- The WorkOS setup (redirect URIs, the `internal_org_id` JWT template, and the org metadata)
  lives in the WorkOS dashboard.

## GitHub CLI

With two remotes, `gh` can pick the official repo for commands like `gh pr create`.
Run this once so it uses your fork:

```bash
gh repo set-default johnathanmelo/humanlayer
```
