# Sylvester

A personal training coach that runs in your own Claude Code: it reads your wearables, health records, check-ins and workouts, builds a plan around your body and the equipment you own, and keeps the next 14 days adjusted to how training is actually going. Your gym screen is a private page on your phone.

> **Heads-up:** Sylvester's Coach is a training assistant, not a doctor or a medical device. It works only from what you and your records tell it, and it can be wrong. Share your plan with your doctor or physio, and stop and get help if something feels wrong: chest pain, dizziness, new numbness or weakness.

## What it does

- **Onboarding (`/setup`):** a 10-minute wizard in your browser (health check, a body map for aches and injuries, your gear, your goals), then a short chat with the Coach about anything that needs a second question.
- **Baseline (`/coach calibrate`):** measured test sessions (body, mobility, balance, strength) that set your starting weights and show left/right differences.
- **Plan (`/coach plan`):** a program built only from your equipment, around every condition and injury, checked by an independent safety reviewer.
- **Rolling 14 days:** rebuilt daily from what happened. A hard session eases the next one, a poor recovery day moves the session, and loads go up one step when you reach the top of the range.
- **Exercise library:** 228 exercises (calisthenics with just a wall and floor, conventional strength, functional and unconventional work, mobility, balance, conditioning), each tagged with what it trains, what it needs and what it loads. Main lifts stay put; accessories rotate every few weeks; bodyweight moves climb their progression ladder; a bad day swaps an exercise for a safe one instead of dropping it; and every session has a no-equipment version on the phone.
- **Phone page:** today's session with pictures and set logging, the daily check-in, the 14-day strip and history, on your own claude.ai page.
- **Data:** Oura, WHOOP, Withings (scales, BP monitors) and Polar pulls, Apple Health import (including medical records), trends and analysis.

## Privacy: two folders

| | App (this repository) | Your data folder (`~/health-data`) |
|---|---|---|
| Holds | Code, the Coach, knowledge, templates, exercise catalogues (links only) | Profile, equipment, goals, medical summary, logs, plans, pictures, keys |
| Shared | Yes, via GitHub | Never. It isn't a git repository, and the app never writes personal data into its own folder. |
| Updated by | `git pull` | You and your Coach |

- **Claude:** the Coach reads your data in your own Claude Code sessions, through your own Claude account, the same as anything else you show Claude.
- **Phone page:** only training content, recovery numbers and the labels of your check-in signals go there; never diagnoses, labs or medications.
- **Commits:** a check runs before every commit to stop personal files or secrets from ever entering the repository.

## Install

You need:
- [Claude Code](https://claude.com/claude-code), signed in;
- Python 3.10 or newer;
- git;
- a claude.ai account for the phone page;
- optionally an Oura ring, a WHOOP strap, Withings scale or BP monitor, a Polar strap or watch, and/or an iPhone with Apple Health.

**The easy way:** open Claude Code in any folder and paste:

> Install Sylvester from https://github.com/nidzus/sylvester into my home folder: clone it, run `sylvester.py init`, then start the setup wizard for me.

Claude installs what's missing, asks before anything it needs your permission for, and opens the wizard in your browser. Afterwards, start `claude` inside the `sylvester` folder: each session begins with a one-line check of where you are in setting up, so the Coach can offer the next step.

**By hand, on Windows:**

```
winget install Python.Python.3.12 Git.Git
git clone https://github.com/nidzus/sylvester.git %USERPROFILE%\sylvester
cd %USERPROFILE%\sylvester
python sylvester.py init
claude
```

**By hand, on macOS:**

```
xcode-select --install            # git, if you don't have it
brew install python               # or the installer from python.org (then run its Install Certificates.command)
git clone https://github.com/nidzus/sylvester.git ~/sylvester
cd ~/sylvester
python3 sylvester.py init
claude
```

Then run `python sylvester.py setup` (the wizard), and `/setup` in Claude Code for the short follow-up. Run `python sylvester.py check` (`python3` on macOS) any time to see what's working. Nothing needs `pip install`: Sylvester uses only Python's standard library.

## Everyday use

| You want to… | Do |
|---|---|
| See today's session | Open your phone page (add it to your home screen) |
| Log a workout or check in | On the phone page |
| Get the latest plan onto the phone | `/coach sync` in Claude Code |
| Ask what to do today, or change it | `/coach today` |
| A progress review | `/coach review` (every 2–4 weeks) |
| A deep look at your data | `/coach analyze` |
| Edit your profile, equipment, goals | `python sylvester.py form`, or tell the Coach |

Every day at the time you chose, the daily task pulls wearable data, refreshes your snapshot and trends, and rebuilds the 14 days. It uses Task Scheduler on Windows and launchd on macOS.

## Commands

```
python sylvester.py init [folder]       create and link your data folder
python sylvester.py where               show where everything is
python sylvester.py check               self-check
python sylvester.py setup               the onboarding wizard
python sylvester.py form [--lan]        local form (--lan: from your phone on home Wi-Fi, behind a passcode)
python sylvester.py connect <source>   one-time wearable sign-in: oura, whoop, withings, polar
python sylvester.py pull                pull wearable data now
python sylvester.py import apple        import an Apple Health export
python sylvester.py daily               what the daily task runs
python sylvester.py schedule [HH:MM]    schedule the daily task (unschedule removes it)
python sylvester.py images              download pictures for your plan's exercises
python sylvester.py plan                rebuild and show the next 14 days
python sylvester.py next                the one next step in setting up
```

## Updating

`git pull` in the app folder. Updates never touch your data, except when a new version changes how the data folder is laid out: then `check` or the next daily run upgrades it once, and says so. If your data folder is newer than the app (you updated on another computer), Sylvester asks you to `git pull` first.

To check an update before relying on it: `python -m unittest` in the app folder runs the tests against a throwaway data folder (no network, nothing of yours is read).

## Pictures

Sylvester ships no images, only catalogues with links. When your plan picks its exercises, `python sylvester.py images` downloads just those into your data folder. The sources are:
- Everkinetic line drawings (CC BY-SA 4.0);
- free-exercise-db photos (public domain).

For anything neither has, your Coach draws a simple start/end diagram for you, or you add your own photos.

## Credits and licences

- **Sylvester's code and text:** MIT licence (see `LICENSE`, and `NOTICE.md` for the medical disclaimer and third-party data): use it, change it, share it, keep the credit. Improvements are welcome as pull requests.
- **Exercise data:**
  - [Everkinetic](https://github.com/everkinetic/data), CC BY-SA 4.0: `coach/exercises/LICENSE-everkinetic.md`.
  - [free-exercise-db](https://github.com/yuhonas/free-exercise-db), Unlicense: `coach/exercises/LICENSE-free-exercise-db.md`.
