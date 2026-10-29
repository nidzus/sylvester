# Training module — designing and progressing the program

Load when: `/coach plan`, `/coach review`, choosing or swapping exercises, or setting progression. Always together with `medical.md` (constraints win over everything here) and `<data>/profile/equipment.json` (only program what exists).

## Program skeleton

1. **Movement patterns, not muscles.** Each week covers: squat/knee-dominant, hinge/hip-dominant, horizontal push, horizontal pull, vertical push*, vertical pull, carry, trunk (anti-extension, anti-rotation, anti-lateral-flexion), plus conditioning. (*Vertical push only if shoulders and lower back tolerate overhead work; landmine press is the default substitute.)
2. **Weekly templates by available days** (from `lifestyle.days_per_week`, `session_minutes`):
   - 2 days: full body A / B; conditioning on other days as walks.
   - 3 days: full body A / B / A then B / A / B; 2 short conditioning sessions.
   - 4 days: upper / lower × 2, or full body × 3 + 1 conditioning-only.
   - 5+: full body × 3 + 2 conditioning; don't add a 4th lifting day before 3 days are consistent for 8 weeks.
3. **Session order:** warm-up (5–8 min: easy cardio + the patterns of the day with light load) → main lift(s) → accessories → trunk/carries → cool-down. Keep the lifting part ≤ the session minutes minus 10.

## Dose

- Returning / beginner: 2–3 hard sets per exercise, 8–15 reps, RPE 6–8 (2–4 reps in reserve). Technique and consistency first, for 4–6 weeks.
- Intermediate: 10–16 hard sets per muscle group per week; main lifts 4–8 reps, accessories 8–15.
- **RPE scale for the person:** 10 = nothing left, 9 = one more possible, 8 = two more, 7 = three more, 6 = easy-ish.
- Rest: 2–3 min for main lifts, 60–90 s for accessories; supersets of non-competing patterns save time.

## Progression

- **Double progression (default):** a rep range per exercise (e.g. 8–12). When all sets reach the top at RPE ≤ 8, add the smallest available increment (check `equipment.json` — dumbbell jumps are often 2–2.5 kg, so use reps or tempo when the jump is too big) and go back to the bottom of the range.
- Bodyweight moves progress via leverage (incline height, tempo, pauses, single-limb), then load (vest, bands).
- Conditioning: add time before intensity; ≤ 10 % more weekly minutes.
- If a lift stalls two sessions in a row with RPE ≥ 9, look at recovery (snapshot) before changing the lift.

## Conditioning — heart-rate zones

Use the snapshot's max HR (highest of observed peak and age estimate) and resting HR (Oura lowest-night or Polar setting) with the Karvonen method: target = resting + % × (max − resting).

| Zone | % of HR reserve | Feel | Use |
|---|---|---|---|
| 1 | 50–60 % | Very easy, full conversation | Recovery, warm-up, post-meal walks |
| 2 | 60–70 % | Easy, can talk in sentences | The base: most weekly minutes here |
| 3 | 70–80 % | Moderate, phrases only | Tempo; limited |
| 4 | 80–90 % | Hard, a few words | Intervals (e.g. 4 × 4 min, or 6–10 × 1 min) |
| 5 | 90–100 % | Max | Rarely; not with uncontrolled BP |

Write the actual bpm ranges into the program. Weekly target for health: ≥ 150 min zone 2–3 plus 1 interval session once there are 4+ weeks of base. If medications blunt HR, use the "feel" column.

Modality choice: bike, rower (only if the back tolerates the flexed position — often not with disc problems; check), incline treadmill/walking, elliptical, swimming, sled, hiking. Walking and hiking the person already does counts: build on it.

## Equipment substitution

When the ideal exercise isn't available, keep the pattern and the stimulus:

| Pattern | Best → fallback |
|---|---|
| Squat | Goblet box squat → dumbbell split squat → step-up → bodyweight box squat |
| Hinge | Trap-bar deadlift from blocks → dumbbell/KB Romanian deadlift (short range) → hip thrust/glute bridge → cable pull-through → band pull-through |
| Horizontal push | Dumbbell bench (neutral grip) → push-up on handles (incline as needed) → band press |
| Horizontal pull | Chest-supported dumbbell row → cable row → TRX/ring row → band row |
| Vertical pull | Lat pulldown → band-assisted pull-up → band pulldown |
| Vertical push | Landmine press → half-kneeling single-arm dumbbell press → band press |
| Carry | Farmer / suitcase carry with dumbbells or KBs (use straps if grip/wrist hurts) |
| Trunk | Dead bug, bird dog, side plank, Pallof press, McGill curl-up |

If a purchase would clearly unlock better programming (e.g. adjustable dumbbells with small jumps, a bench, a trap bar), list it under "Worth buying" with a one-line reason and approximate priority — never assume it's bought.

## Fat-loss context

Training supports fat loss; nutrition drives it. When the goal involves weight:
- Protein ~1.6 g/kg of *target* bodyweight per day (defer to doctor if kidney function is reduced).
- Modest deficit: aim for 0.5–0.75 % of bodyweight lost per week; faster costs muscle.
- Daily steps (Oura) are a big lever: hold or nudge up, don't let them drop on lifting days.
- Track the trend (Withings 7-day average), not daily weigh-ins.

## Program file conventions

- Every exercise row: exercise · sets × reps · load (kg) or RPE · rest · cue. Write sets × reps as `3 × 8–12` so the Log tab can pre-fill it.
- Session files use one table with an `Exercise` column header.
