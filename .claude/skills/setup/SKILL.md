---
name: setup
description: Onboard a new Sylvester user, or resume an unfinished onboarding. Use for "/setup", "get me started", "onboard me", or when the coach finds no onboarding in the profile. Creates the private data folder, opens the setup wizard in the browser (disclaimer, health, injuries, equipment, goals, devices), follows up in chat on what needs judgement, connects wearables, publishes their phone page, schedules the daily task, and starts the baseline calibration.
---

# Setup: onboarding a new person

A browser wizard for the facts, then a short, friendly conversation for what needs judgement. One topic at a time, a few questions per message, and save as you go so nothing is lost if they stop halfway. Every step is resumable: check what's already filled in and skip it.

## 0. The data folder

Run `python sylvester.py where` (`python3` on macOS). If the data folder is missing:
1. Ask where to keep it. The default is `~/health-data` (on Windows: `C:\Users\<name>\health-data`); anywhere outside this app folder is fine, but never inside a git repository or a synced public folder.
2. Run `python sylvester.py init <folder>`. It creates the folder, links it, and lets Claude Code read and write it from here.

After `init`, tell them Claude Code may need a restart to pick up the new folder permission.

## 1. The setup wizard (the person fills it in)

The facts come from a page in their browser, not from chat. Start it **in the background** (Bash `run_in_background: true`) so you're woken up when they finish:

```
python sylvester.py setup        # python3 on macOS
```

It opens http://localhost:8765/setup and covers, in about 10 minutes:
- **Welcome:** name, units and the disclaimer, which they must tick before anything else.
- **You:** date of birth, sex, height, weight, dominant side, experience, current activity, known numbers.
- **Health check:** seven yes/no screening questions, conditions and medication.
- **Aches:** a body map. Each spot becomes an `injuries` entry with status, pain today, `triggers` (movements that make it worse) and notes. Also their early warning signs and anything a doctor said to avoid.
- **Gear:** home, gym and/or outdoors, with equipment details. It writes `equipment.json` items and `load_steps`, always in kg.
- **Goals:** up to three in priority order, with target and date, plus their week and preferences.
- **Devices:** wearables and iPhone or Android.

Tell them, in one or two sentences, that a page has opened in their browser, and that you'll carry on when they press Finish. Then wait. Don't ask the same questions in chat.

**When they finish,** the process ends by itself and you're notified; they may also just type "done". Then read the three profile files and `settings.json`. If it's still running when they say done, they haven't pressed Finish yet: ask them to.

**If the page can't open** (no browser, a remote machine), fall back to asking the same things in chat, a few at a time, and write the same fields.

Everything the wizard wrote is marked `"source": "setup"`; the wizard rewrites those entries if they run it again, and leaves anything else alone. To change answers later, they can run it again, use `python sylvester.py form`, or just tell you.

## 2. Follow-up conversation (what a form can't do)

Read what they entered and ask only what needs a second question. Keep it short and warm; use their name.

- **Screening** (`health_profile.screening.answers`):
  - A "yes" to `chest`, `dizzy` or `supervised` means they should see a doctor before training. Say so plainly, plan only gentle sessions until they confirm clearance, and record it in `restrictions.medical_advice`.
  - For other yeses, ask one question each: what it is and whether it's controlled.
- **Conditions and medication:** for anything that changes heart rate or blood pressure (beta-blockers, for example), note that heart-rate zones need RPE instead.
- **Injuries:** for each one marked "hurts now" or "getting better", ask:
  - what a doctor or physio found;
  - which movements are fine (`ok_movements`).
- **Personal signals.** Turn `onboarding.warning_signs` into `signals` entries (format in `core/signals.py`):
  - key, label, scale and hint;
  - `levels`: which level means an easy day, which means recovery, and which exercise `tags` to avoid;
  - a `stop` rule.

  Read the levels back in plain words and adjust them with the person.
- **Equipment:**
  - Check that `load_steps` look sensible. Fill gaps (fixed dumbbells with no weights listed, a barbell with no plates).
  - Note anything unsafe in the item's `notes`, e.g. squat stands with no safeties.
  - For a gym, ask what's missing or limited.
- **Goals:** check each target against their profile and time frame, and say so gently if it's unrealistic. Ask "why it matters" if it's blank; it helps on hard days.
- **Apple Health (iPhone owners):** offer to import it.
  - Steps: Health app → profile picture → *Export All Health Data*. Move the zip to this computer and unzip it into `<data>/imports/apple_health_export/`. Run `python sylvester.py import apple`.
  - The import builds `records/clinical_summary.md` from their medical records, if they've connected any. Compare it with what they entered, and ask about anything new, marked "from medical records".

- **Limits** (`health_profile.json` → `limits`; see `coach/knowledge/exercise_library.md`):
  - For each condition, start from the matching profile in `coach/library.json` → `conditions` (`avoid`, `caution`).
  - Add the stresses behind each injury's `triggers`, e.g. "kneeling" → `kneeling`, "reaching overhead" → `overhead`, "bending forward" → `spine_flex_loaded`, plus anything a clinician ruled out.
  - Read them back in plain words: "I'll never give you loaded forward bending or twisting; deep knee bends only when your plan names them."

  These are what the daily plan uses to pick, rotate and swap exercises.

When it all checks out, set `review.status` to `"yes, <date>"`.

## 3. Connect wearables (optional)

Follow `docs/CONNECT.md`:
- **Oura:**
  1. They register their own free Oura API app.
  2. You write `<data>/secrets/oura_config.json` from the client id and secret they paste. Never echo the secret back.
  3. They run `python sylvester.py connect oura`.
- **Polar:** the same with `polar_config.json` and `connect polar`.
- **Apple Health:** done in step 2.

Connect only what they ticked in the wizard (`onboarding.devices`): `oura`, `polar`, `whoop` and `withings` each follow the same steps in `docs/CONNECT.md` (`<name>_config.json`, then `python sylvester.py connect <name>`). For devices Sylvester can't read (Garmin, Fitbit, other BP monitors or scales), say so, and suggest typing blood pressure or weight into the check-in if they want. Garmin data reaches Sylvester through Apple Health on an iPhone.

Then run `python sylvester.py pull` and `coach/snapshot.py` to confirm data arrives. If a pull says Python can't verify HTTPS certificates (python.org Python on a Mac), have them run `Install Certificates.command` from Applications > Python 3.x.

## 4. Their phone page

Each person gets their own private page in their own claude.ai account:
1. Load the `artifact-capabilities` skill.
2. Publish `app/phone.html` as a new artifact with the `db` capability (owner-only: only the owner can read or write) and the `assets` capability.
3. Save the returned link in `<data>/settings.json` → `phone_url`.
4. Push `config/checkin` (from `coach/phone.py plan` once a plan exists; before that, write `{"signals": ...}` from `core.signals`).
5. Tell them how to put it on the home screen:
   - **iPhone:** open the link in Safari → Share → *Add to Home Screen*.
   - **Android:** Chrome menu → *Add to Home screen*.
   - They must be signed in to claude.ai in that browser.

## 5. Daily task

Run `python sylvester.py schedule 11:00`, or another time after they usually wake. Windows uses Task Scheduler; macOS uses launchd. The task pulls wearable data, refreshes the snapshot and trends, and rebuilds the 14-day plan. The phone page gets the new plan whenever they open Claude and say `/coach sync` (or run any coach mode).

## 6. Baseline, then the first plan

1. Run the coach's `/coach calibrate`: build their batteries in `<data>/plans/calibration.json` from the catalogue, matching their equipment and profile, and have the safety-reviewer check them.
2. Push the first battery to their phone.
3. Explain: two or three short test sessions on different days, nothing to failure.
4. When results are in, `/coach plan <goal>` writes the plan and the rolling 14 days.

## 7. Finish

Run `python sylvester.py check` and fix anything marked `!!`. Set `onboarding.completed` to today's date. End with a short summary:
- where their data lives;
- their phone link;
- what happens daily;
- the three commands they'll use most: `/coach today`, `/coach sync`, `/coach review`.
