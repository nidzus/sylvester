# Connecting your data sources

Every source is optional. Each one you add makes the Coach's recovery and trend calls better.

Keys and tokens go only into your data folder's `secrets/` folder. Never paste them anywhere else.

## Oura ring

1. Sign in at <https://cloud.ouraring.com/oauth/applications> and create a new application.
   - **Redirect URI:** exactly `http://localhost:3000/callback`
   - Any name, any website. Select every data scope.
2. Give the Coach the **Client ID** and **Client Secret**. It writes `<data>/secrets/oura_config.json` for you:
   ```json
   {"client_id": "…", "client_secret": "…", "redirect_uri": "http://localhost:3000/callback"}
   ```
3. Run `python sylvester.py connect oura`. A browser opens; approve it. The script catches the reply itself.
4. Run `python sylvester.py pull oura` to get the first data.

For a longer history:
```
python ingest/oura_pull.py pull 2024-01-01 2026-01-01
```
Pull at most a year at a time.

Oura may require an active membership for API data.

## WHOOP

1. Sign in at <https://developer-dashboard.whoop.com> and create an app.
   - **Redirect URL:** exactly `http://localhost:3002/callback`
   - **Scopes:** `read:recovery`, `read:cycles`, `read:sleep`, `read:workout`, `read:profile`, `offline`
2. Give the Coach the **Client ID** and **Client Secret**. It writes `<data>/secrets/whoop_config.json`:
   ```json
   {"client_id": "…", "client_secret": "…", "redirect_uri": "http://localhost:3002/callback"}
   ```
3. Run `python sylvester.py connect whoop`, approve in the browser, then `python sylvester.py pull whoop`.

The recovery score becomes the daily traffic light (WHOOP's own bands: green 67+, red under 34). HRV, resting heart rate, sleep and skin temperature feed the snapshot just like Oura's. An app in development mode can connect up to 10 WHOOP members.

For a longer history: `python ingest/whoop_pull.py pull 2025-01-01 2026-01-01`.

## Withings (scale, blood pressure monitor, watch or sleep mat)

1. Create a free developer account and an application at <https://developer.withings.com> (Public API).
   - **Callback URL:** `http://localhost:3003/callback`
2. Give the Coach the **Client ID** and **Secret**. It writes `<data>/secrets/withings_config.json`:
   ```json
   {"client_id": "…", "client_secret": "…", "redirect_uri": "http://localhost:3003/callback"}
   ```
3. Run `python sylvester.py connect withings` and approve. Withings sign-in codes expire after 30 seconds, but the script exchanges the code at once.
4. Run `python sylvester.py pull withings`. For your whole history: `python ingest/withings_pull.py pull 2015-01-01 2026-12-31`.

Weight and body fat go to the snapshot's body section, and blood pressure readings to its BP section, which the plan's BP gates read. Steps and sleep come from Withings watches and sleep mats.

If the developer dashboard won't accept a `localhost` callback, register the address it suggests instead. The connect step then asks you to paste the address you land on after approving.

## Polar (H10 strap or a Polar watch)

1. Register an application at <https://admin.polaraccesslink.com/>.
   - **Redirect URI:** exactly `http://localhost:3001/callback`
2. Give the Coach the **Client ID** and **Client Secret**. It writes `<data>/secrets/polar_config.json` with the same three fields, using port 3001.
3. Run `python sylvester.py connect polar`. Sign in to Polar Flow and approve.
4. Run `python sylvester.py pull polar`.

The Polar API only sees data from the day you connect onwards. To backfill older sessions and fitness tests:
1. Request your data at <https://account.polar.com> → *Download your data*.
2. Unzip it.
3. Run `python sylvester.py import polar <unzipped folder>`.

With only a chest strap, expect exercises but no daily activity, sleep or recharge data.

## Apple Health (iPhone)

1. On the iPhone: Health app → your picture (top right) → **Export All Health Data**. It can take a few minutes.
2. Move `export.zip` to the computer (AirDrop, iCloud Drive, a cable).
3. Unzip it so that the files end up in `<data>/imports/apple_health_export/` (that folder should contain `export.xml`).
4. Run `python sylvester.py import apple`.

The import covers:
- daily weight, body fat, blood pressure, steps, glucose and workouts;
- your medical records, if you've connected them in Health. These go into `records/clinical_summary.md`.

Re-export and re-import every month or two; it rebuilds from scratch each time.

## Blood pressure and anything without an app

Type readings into the daily check-in on the phone page (BP field), or tell the Coach.
