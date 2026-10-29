# Sylvester: the app

A personal training coach run from Claude Code. This folder is the **shared app** (a git repository). Each person's data lives in a **separate data folder** (default `~/health-data`), found through `~/.sylvester.json`. `python sylvester.py where` prints both.

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
- **Coach:** `.claude/skills/coach/`, `.claude/skills/setup/` (onboarding, with the disclaimer), agents `safety-reviewer` and `health-analyst` in `.claude/agents/`, knowledge in `coach/knowledge/`.
- **Rolling plan:** `coach/rolling.py`. **Phone bridge:** `coach/phone.py`. **Reports:** `coach/snapshot.py`, `trends.py`, `baseline.py`.
- **Check-in scales:** the common scales plus each person's own signals: `core/signals.py`.
- **Calibration:** shared tests in `coach/assessments.json` (no personal loads; keep ids stable), merged with `<data>/plans/calibration.json` by `coach/catalogue.py`.
- **Pictures:** only catalogues ship (`coach/exercises/*.json`). Images download into `<data>/media/` on demand. Never add images from sources without a clear free licence (ExerciseDB GIFs, MuscleWiki, ExRx).
- **Pages:** `app/phone.html` (each person publishes their own artifact from it), `app/setup.html` (the onboarding wizard, `sylvester.py setup`) and `app/index.html` (the local form), both served by `app/server.py`. The wizard and the form edit the same profile files; entries the wizard owns carry `"source": "setup"`.

## Conventions

- Python 3.10+, standard library only (the pulls use `ingest/http_lite.py` and `ingest/oauth_local.py` for HTTPS, no `requests`).
- LF line endings (`.gitattributes`). Metric units.
- Tests: `python -m unittest` (standard library, a throwaway data folder, a fake API on localhost). Add a test with any change to `rolling.py`, `library.py`, the pulls or the snapshot.
- Generated files in the data folder (`records/snapshot.*`, `trends.*`, `baseline.*`, `plans/*/schedule.*`): regenerate, don't hand-edit.
- Apple Health `export.xml` can be over a gigabyte: stream it with `iterparse`, never load it whole.
