# Recovery module — reading the body's signals

Load when: choosing today's session (`/coach today`), reviewing a block, or when the person asks why they feel flat. Data: `<data>/records/snapshot.md` (recovery, training, check-ins), `<data>/records/trends.md` (long-term).

## Principle

Judge everything against **this person's own baseline**, not population norms. A 7-day average versus the 60-day baseline is the default comparison; a single night is noise unless it's extreme. Two independent signals agreeing (e.g. HRV down *and* resting HR up) count for far more than one.

## Signals, in order of usefulness

| Signal | Source | What it means | Threshold worth acting on |
|---|---|---|---|
| Temperature deviation | Oura | Illness coming on, sometimes alcohol or heat | ≥ +0.5 °C → rest; ≥ +0.3 °C with other flags → easy only |
| HRV (rMSSD, nightly avg) | Oura | Autonomic recovery; drops with stress, illness, alcohol, hard training, poor sleep | 7-day avg ≥ 10 % below baseline; or a single night ≥ 25 % below |
| Lowest night HR | Oura | Rises with fatigue, illness, dehydration, alcohol, late meals | 7-day avg ≥ 3 bpm above baseline; single night ≥ 5 bpm |
| Sleep duration / efficiency | Oura | Less than ~6.5 h repeatedly impairs recovery, insulin sensitivity, appetite control and mood | 7-day avg < 6.5 h, or two nights < 5.5 h |
| Readiness score | Oura | Oura's own blend of the above | < 70 = poor, 70–79 = fair, ≥ 80 = good — but trust the components over the score |
| Check-in: energy, soreness, mood, pain | Form | Subjective — often the earliest warning | Energy ≤ 2 or soreness ≥ 4 two days running |
| Training load, acute:chronic | Polar + log | Recent load relative to what the body is adapted to | > 1.5 = spike, deload; < 0.8 for weeks = detraining |

Missing data: Oura rows with no sleep (ring off, battery) make trends less reliable; the snapshot flags this. Say so rather than over-reading.

## Turning signals into the day's decision

The snapshot's green / amber / red status is the starting point. Adjust it with what the person tells you:

- **Feels good, data amber** → train as planned but cap at RPE 8; data often lag behind how you feel after a good night.
- **Feels bad, data green** → trust the person: amber treatment. Ask about life stress, pain, motivation.
- **Pain up** (check-in pain ≥ 4 or new pain) → this overrides recovery status; follow the medical module.
- **Two or more red days in a row** → a lighter week is probably needed; look for the cause (sleep, illness, work stress, under-eating).

## Deloads

- Planned: every 4th–6th week, cut volume ~40 % (fewer sets), keep intensity moderate, keep the habit of showing up.
- Reactive: when 7-day HRV is ≥ 10 % below baseline for 7+ days with resting HR up, or performance drops two sessions in a row with high effort, or the person reports persistent fatigue/soreness.
- Returning after illness: first session back at ~50 % volume, RPE ≤ 6; normal after two good sessions with no relapse.

## Sleep — the biggest lever

Treat sleep as part of the program. For anyone working on weight, insulin resistance or blood pressure, short sleep directly worsens glucose control, BP and appetite. If 7-day average < 6.5 h, the most useful advice of the week may be about sleep, not training:
- Consistent wake time (± 30 min) matters more than bedtime.
- Hard training finished ≥ 2–3 h before bed; caffeine stopped ≥ 8 h before; alcohol visibly lowers HRV and raises night HR in Oura — point to their own data when it shows this.

## Long-term markers to watch in reviews

- Resting / lowest-night HR trending down over months = aerobic fitness improving.
- HRV baseline trending up = good adaptation (slow; months).
- Polar fitness-test VO2max estimate: re-test every ~8 weeks under the same conditions (morning, rested, lying down).
