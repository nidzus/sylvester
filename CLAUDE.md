# Sylvester: the app

A personal training coach run from Claude: a Claude Code plugin (this folder is the plugin and its marketplace) and a Claude Desktop extension. This folder is the **shared app** (a git repository). Each person's data lives in a **separate data folder** (default `~/health-data`), found through `~/.sylvester.json`. `python sylvester.py where` prints both.

## The one rule: nothing personal in this folder

- Never write profile, medical, check-in, workout, plan, picture, token or settings files into this folder; they go in the data folder (`core/paths.py` has every location).
- Never put a person's details into code, skills, knowledge, catalogue or templates: no names, conditions, injuries, loads, equipment, links to their phone page, or paths under their home folder. Generalise, and put the personal part in their data folder (profile, `signals`, `plans/calibration.json`, plan routines).
- Before committing, `tools/check_clean.py` runs (git hook `tools/hooks/pre-commit`, enabled by `sylvester.py init`). Don't bypass it. If it blocks something, remove the personal content rather than the check.

## Where things are

- **Entry point:** `sylvester.py`. The same commands work on Windows and macOS, so keep them platform-neutral (pathlib, `sys.executable`, no shell-specific syntax).
- **Ingestion:** `ingest/`: Oura, Polar, WHOOP, Withings, Apple Health. Secrets live in `<data>/secrets/`. Never print token or config contents.
- **Session start:** a SessionStart hook (written by `sylvester.py init` into the uncommitted `.claude/settings.local.json`) runs `sylvester.py next`, which tells you in one line where this person is in setting up. Offer that step; don't push it.
- **Data-folder version:** `paths.SCHEMA`. If a change needs existing data folders reshaped, bump it and add a step to `MIGRATIONS` in `sylvester.py` (runs once per folder, from `check` and `daily`).
- **Exercise library:** `coach/library.json` (patterns, progression families, equipment, purposes, stresses, condition guidance with sources, session mixes) and `coach/library.py`. Keep ids stable: plans and logs refer to them. Add exercises there, never in a person's data.
- **Coach (the plugin):** `.claude-plugin/plugin.json` (with the MCP server) and `marketplace.json`; skills `skills/coach/`, `skills/setup/` (onboarding, with the disclaimer), `skills/balance/` (the same coach's sleep and stress focus: one coach, one plan owner, never a second persona); agents `safety-reviewer` and `health-analyst` in `agents/`; knowledge in `coach/knowledge/`. Commands are namespaced: `/sylvester:coach`. Skills and agents name app files through `${CLAUDE_PLUGIN_ROOT}`, never a path relative to the session's folder. `claude plugin validate .` checks it.
- **Rolling plan:** `coach/rolling.py`. **Phone bridge:** `coach/phone.py`. **Reports:** `coach/snapshot.py`, `trends.py`, `baseline.py`.
- **Check-in scales:** the common scales plus each person's own signals: `core/signals.py`.
- **Calibration:** shared tests in `coach/assessments.json` (no personal loads; keep ids stable), merged with `<data>/plans/calibration.json` by `coach/catalogue.py`.
- **Pictures:** only catalogues ship (`coach/exercises/*.json`). Images download into `<data>/media/` on demand. Never add images from sources without a clear free licence (ExerciseDB GIFs, MuscleWiki, ExRx).
- **Pages:** `app/phone.html` (each person publishes their own artifact from it), `app/setup.html` (the onboarding wizard, `sylvester.py setup`) and `app/index.html` (the local form), both served by `app/server.py`. The wizard and the form edit the same profile files; entries the wizard owns carry `"source": "setup"`.

- **Shared TypeScript:** `shared/` is pure TypeScript (no React, no Node APIs) used by the phone and the MCP server: `engine/` (a port of `rolling.py`, `library.py`, `signals.py` and the snapshot's recovery), `model.ts` (everything one person keeps, and `sylvester.py export`'s format), `changes.ts` (what a proposal may change and the checks it must pass), `review.ts` (the safety reviewer's prompt and document), `setup.ts`, `starter.ts`, `clearance.ts`. Change the Python engine and `shared/engine/` together: `mobile/test/parity.test.ts` (via `tools/parity.py`) fails if they lay out different days.
- **MCP server:** `mcp/` (Node 22.18+ runs `mcp/src/server.ts` as is; no runtime dependencies). Tools grouped by focus (status and setup; today and training; recovery, sleep and balance; profile and reference; propose, review, apply). It reads and writes the data folder in the desktop's own formats (`mcp/src/data.ts`), so the Python app and the server can be used on the same folder. Plan changes go `propose_changes` → `review_brief` → `apply_proposal`; nothing writes a plan around the checks. Instructions and menu prompts: `mcp/src/instructions.ts`.
- **Desktop extension:** `mcp/extension/manifest.json`, built by `cd mcp && npm run extension` into `mcp/dist/sylvester.mcpb` (the server bundled into one file plus the catalogues; Claude Desktop's own Node runs it). The manifest lists every tool and prompt: after adding or renaming one, `node scripts/manifest-lists.mjs --write`; the tests fail until it matches. No `user_config` setting may be `required` or have a `default` (Claude Desktop then leaves the extension switched off). The versions in `plugin.json`, the manifest and `mcp/src/server.ts` move together.
- **iPhone app:** `mobile/` (Expo, TypeScript; `mobile/README.md`). It imports `../shared` (Metro watches it: `mobile/metro.config.js`). The app reads the catalogues through `mobile/scripts/build-assets.mjs`; `sylvester.py export` is its import format. The Coach there only proposes changes (`shared/changes.ts` checks them, then a safety-review call). `proxy/` is the optional server for invite codes and Oura sign-in. Nothing personal goes into either: test fixtures are made-up people.

## Conventions

- Python 3.10+, standard library only (the pulls use `ingest/http_lite.py` and `ingest/oauth_local.py` for HTTPS, no `requests`).
- LF line endings (`.gitattributes`). Metric units.
- Tests: `python -m unittest` (standard library, a throwaway data folder, a fake API on localhost). Add a test with any change to `rolling.py`, `library.py`, the pulls or the snapshot. The app: `cd mobile && npm test`; the coach's tools: `cd mcp && npm test` (also runs `coach/rolling.py` on what the server wrote); the proxy: `cd proxy && npm test`. TypeScript: `npm run typecheck` in `mobile/` and `npx tsc --noEmit` in `mcp/`.
- Generated files in the data folder (`records/snapshot.*`, `trends.*`, `baseline.*`, `plans/*/schedule.*`): regenerate, don't hand-edit.
- Apple Health `export.xml` can be over a gigabyte: stream it with `iterparse`, never load it whole.
