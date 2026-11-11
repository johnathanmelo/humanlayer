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
  (`--stop`, `--restart`, `--no-open`, `--dev-ui`, `--rebuild-ui`). By default it serves a
  production build of `riptide-ui` with `vite preview` (tmux window `ui`), because the Vite dev
  server renders large documents much more slowly. It rebuilds only when the UI sources, the
  workspace packages, `bun.lock` or the `VITE_` variables change (stamp in
  `apps/riptide-ui/dist/.humanlayer-build-stamp`). A build takes 2-3 minutes and up to about
  8 GB of RAM. Use `--dev-ui` when you are changing the UI and want hot reload.
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

  The provider runs at most 3 `claude` processes at once (`HUMANLAYER_CLAUDE_CODE_MAX_CONCURRENCY`)
  and starts them with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Without `OPENAI_API_KEY`,
  `reliable-language-model.ts` returns the primary model directly instead of retrying it before a
  fallback that cannot work.
- Large Markdown documents: changes to upstream files that cut repeated work per edit. Expect
  conflicts here when upstream touches the same code; keep the behavior, take their structure.
  - `packages/ai/src/agents/design-doc-open-questions/check-if-design-doc-has-open-questions.ts`:
    the open-questions count is cached by content hash (`createCachedQuestionCounter`), so the
    same design doc never pays for a second Sonnet call.
  - `apps/riptide-daemon/src/lib/artifact-sync-ledger.ts` and `artifact-sync-utils.ts`
    (`syncArtifactRead`, `findUnchangedTextRead`, `rememberDesignQuestions`,
    `parseArtifactFrontmatter`): a Read of an unchanged design doc repeats the session's last
    answer instead of uploading again, and gray-matter is called with options so it stops
    caching every document version in daemon memory.
  - `apps/riptide-daemon/src/agents/claudecode/hooks/artifact-read-sync-hook.ts`,
    `artifact-sync-hook.ts` (Write no longer sends the body twice), `agents/codelayer/hooks.ts`
    and `effects/services/fold-sessions/fold-product-hooks.ts` use them.
  - `packages/ui/src/artifact-viewer-v2/viewer/useMarkdownViewerV2Editor.ts`
    (`replaceEditorMarkdown`): an agent edit replaces only the changed range of the open
    document instead of rebuilding it, so unchanged blocks keep their DOM, node views and code
    highlighting. Unlabelled code fences default to `plaintext` there and in
    `markdown-viewer/MarkdownViewer.tsx`, instead of trying every grammar.
  - `packages/ui/src/artifact-viewer-v2/folding/SectionFoldingExtension.ts` and
    `viewer/CommentHighlightExtension.ts`: folding decorations are built once per change, not on
    every view update, and unchanged folds or highlights dispatch nothing.
  - `packages/ui/src/artifact-viewer-v2/anchor/doc-text-search.ts`: comment anchors search a
    flattened copy of the document built once per document, without one object per character.
  - `packages/ui/src/lib/content-key.ts` (new) and `artifact-viewer-v2/diff/ArtifactVersionDiff.tsx`:
    version diffs are cached by a content key instead of being parsed three times.
  - `apps/riptide-ui/src/components/artifact-viewer-v2/useArtifactVersions.ts` hashes the document
    only while the version view is open; `apps/riptide-ui/src/minimalist/components/Prose.tsx` and
    `ArtifactPanel.tsx` reuse rendered blocks and memoize comment threads.
  - `apps/riptide-ui/vite.config.ts`: the TanStack devtools plugin runs without source injection,
    console piping and enhanced logs. Set `RIPTIDE_UI_FULL_DEVTOOLS=true` in `.env` to turn them
    back on (for example, to click from the devtools to a component's source).
- Local stack listens on loopback only, so other machines on the network (café or office Wi-Fi)
  cannot reach it. MinIO uses the default `minioadmin` login and Redis has no password, and the
  Postgres database holds the Jira and Linear OAuth tokens in plain text.
  - `docker-compose.yaml` and `docker-compose.test.yml`: every host port is
    `127.0.0.1:<port>:<container port>`.
  - `apps/devstack/src/lib/caddy.ts` (`renderCaddyConfig`): the generated Caddyfile starts with
    `default_bind 127.0.0.1 [::1]`, and `apps/devstack/src/test/caddy.test.ts` checks it.
  - `apps/riptide-api/src/index.ts` and `apps/riptide-electric-proxy/src/index.ts`: listen on
    `HUMANLAYER_BIND_HOST` when it is set. `.env` sets it to `127.0.0.1`; when it is unset they
    listen on every interface, as upstream does (their Docker images need that).

  If you rebuild `.env`, add `HUMANLAYER_BIND_HOST=127.0.0.1` again. To check, run
  `ss -ltn` and look for `0.0.0.0` or `*` next to the stack's ports.
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
