# Sylvester for iPhone

The Sylvester coach as a native iPhone app (Expo / React Native, TypeScript). Everything lives on the phone; the Coach is Claude, through the person's own Anthropic API key or an invite code for the owner's account (`../proxy`).

| | |
|---|---|
| **Today** | morning check-in, today's session or recovery day and why, recovery at a glance |
| **Plan** | the rolling 14 days, calibration, routines, the plan in words, the change log |
| **Status** | recovery colour and why, last night, this week against your usual with 14-day bars |
| **Coach** | conversations; the Coach proposes changes as cards, a safety review runs before applying |
| **Settings** | Coach mode and model, Apple Health, Oura, import from the desktop, backup, erase |

## How it fits the desktop app

- **One engine.** `../shared/engine/` (shared with the desktop's MCP server in `../mcp`) is a line-for-line TypeScript port of `coach/rolling.py`, `coach/library.py`, `core/signals.py` and the recovery part of `coach/snapshot.py`. `test/parity.test.ts` runs both on the same scenarios (`test/fixtures/scenarios.json`) and fails if a single day differs. Change the Python and the TypeScript together.
- **One catalogue.** `scripts/build-assets.mjs` copies `coach/library.json`, `coach/assessments.json`, the picture links, `coach/knowledge/*.md` and `templates/plan` into `src/generated/` on every `npm install` and test run. Never edit `src/generated/`.
- **Same data shapes.** `python sylvester.py export` writes one file with the profile, active plan, calibration, logs and a year of wearable days (no secrets, no medical records file); the app imports it (Settings, or the first screen). The app's backup is the same format.
- **The Coach** follows the desktop Coach and safety reviewer (`src/coach/prompts.ts`, `../shared/review.ts`), but it can only *propose* changes (`../shared/changes.ts`). Local checks block anything that loads an avoided stress, breaks the plan or ignores a health-check "yes"; an independent safety-review call runs before anything that changes exercises or intensity is applied.

## Develop (Windows or Mac; no Mac needed)

```
cd mobile
npm install          # also runs scripts/build-assets.mjs
npm test             # engine, parity with Python (needs python on the PATH), Coach loop, setup
npm run typecheck
```

There's no simulator on Windows; the app runs as a development build on an iPhone.

## Build and install with EAS (no Mac needed)

You need an Apple Developer Program membership: yours, or a team you've been added to (App Store Connect → Users and Access, role App Manager or Admin). In this repo:

1. `npx eas-cli@latest login` (free Expo account), then `npx eas-cli@latest init` (adds the project id to `app.json`).
2. In `app.json` set `ios.bundleIdentifier` to an id on that team (e.g. `com.<team>.sylvester`), and `extra.serverUrl` to your Sylvester server if you run one.
3. Credentials: either sign in with your Apple ID when EAS asks, or have the team owner create an **App Store Connect API key** (Users and Access → Integrations) and give you the .p8 file, key id and issuer id; EAS uses it to create the certificates and to upload. The team owner can revoke it at any time.
4. **On your own iPhone first:** `npx eas-cli@latest build --profile development --platform ios` (registers your device, builds in the cloud, gives you an install link). Then `npx expo start` on your computer and open the app.
5. **TestFlight:** `npx eas-cli@latest build --profile production --platform ios --auto-submit`. Internal testers (members of the team, up to 100) get it at once; external testers (anyone, up to 10,000, by link) after a short beta review.

The App Store listing will show the team's name as the seller. For a public release, the account holder is responsible for the privacy policy and Apple's health and AI-data rules (the app already asks for consent before anything goes to Claude, and reads Apple Health without writing to it).

## What isn't done yet

- Not run on a device yet: the engine, the Coach loop, setup and the server are tested; the screens, Apple Health and the Oura sign-in need the first device build.
- No notifications or Apple Watch app. Polar, Garmin and Withings arrive through Apple Health; WHOOP isn't connected directly.
- The app's backup can't yet be merged back into the desktop data folder.
