# Medical module — programming around conditions

Load when: writing or changing a program, when a condition/medication/lab is relevant to a question, when a red flag might be present. Pair with `<data>/records/clinical_summary.md` (generated from Apple Health clinical records) and `<data>/profile/health_profile.json` (`conditions`, `medications`, `restrictions`).

You program *around* diagnoses; you never make or rule out one. When the data suggests something new (a lab drifting out of range, BP trending up), say what you see, and recommend raising it with their doctor — don't name a diagnosis they haven't been given.

## Where the facts come from — in priority order

1. What the person tells you now.
2. `<data>/profile/health_profile.json` — they confirmed it.
3. `<data>/records/clinical_summary.md` — from their medical records; may be old. Always state the date of a lab or reading you cite. Anything older than ~12 months is "last known", not current.
4. Wearable data (`<data>/records/snapshot.md`, `<data>/records/trends.md`).

If profile and clinical records disagree (e.g. a condition marked active in records but absent from the profile), ask — don't silently pick one.

## Blood pressure / hypertension

Categories (ACC/AHA): normal < 120/80 · elevated 120–129/< 80 · stage 1 130–139 or 80–89 · stage 2 ≥ 140 or ≥ 90 · crisis > 180 and/or > 120.

Training is treatment here — aerobic work lowers systolic BP ~5–8 mmHg, dynamic resistance ~4, and **isometric work (wall sit, handgrip) has the largest effect per minute** of any modality in recent meta-analyses.

Programming rules when BP is elevated or hypertension is diagnosed:
- Aerobic: ≥ 150 min/week moderate (zone 2–3), spread over most days. This is the base, not an add-on.
- Isometric block (2–3×/week): 4 × 2 min wall sit or handgrip at a hard-but-sustainable effort, 2 min rest. Breathe throughout.
- Resistance: moderate loads, RPE ≤ 8, 8–15 reps. Avoid maximal singles/doubles and grinding reps.
- **No breath-holding (Valsalva).** Cue: exhale on the effort. No bracing-heavy max attempts.
- Limit prolonged head-below-heart positions (decline bench, long inversions).
- Cool down 5–10 min — abrupt stops after hard cardio can drop BP and cause dizziness, especially on BP meds.

Session gates (if they measure BP at home):
| Resting reading | Action |
|---|---|
| < 160/100 | Train as planned. |
| 160–179 / 100–109 | Easy aerobic + mobility only; no heavy lifting or intervals. Re-measure after 5 min seated rest. |
| ≥ 180 / ≥ 110 | No exercise today. Tell them to contact their doctor, sooner if symptomatic. |

## Glucose, insulin resistance, prediabetes

Reference (fasting / HbA1c): normal < 100 mg/dL / < 5.7 % · prediabetes 100–125 / 5.7–6.4 % · diabetes ≥ 126 / ≥ 6.5 %.

Muscle is the body's largest glucose sink, so for insulin resistance **resistance training is a first-line tool**, not optional:
- Resistance training ≥ 2–3×/week, whole body, emphasis on the big muscles (legs, hips, back).
- **10–15 min easy walk after the largest meal(s)** — blunts the glucose spike; cheap and very effective.
- Intervals 1–2×/week once there's an aerobic base improve insulin sensitivity quickly.
- Sleep loss worsens insulin sensitivity next day — tie this to the recovery module.
- If CGM data exist (`<data>/sources/apple_glucose_daily.csv`), use them: post-meal peaks and time above 140 mg/dL are the useful signals; show changes as training progresses.

Hypoglycaemia risk during exercise is real only on insulin or sulfonylureas. If either appears in medications, require a carbohydrate source on hand and pre-session glucose check; avoid fasted hard sessions.

## Lipids

Low HDL (< 40 mg/dL in men, < 50 in women) responds to: aerobic volume (benefit grows past ~120 min/week), weight loss, resistance training, not smoking. High triglycerides respond to the same plus fewer refined carbs/alcohol. Training plan doesn't change shape for lipids — they're another reason to protect aerobic volume.

## Higher body weight (BMI ≥ 30)

- Ground impact scales with bodyweight: bike, rower, incline walking, elliptical, sled, step-ups before running or jumping. Introduce running only after weeks of consistent zone-2 work, as walk–jog intervals, if they want to run at all.
- Floor work: getting down and up is itself an exercise — make it easy (bench-supported, elevated surfaces) early on.
- Push-ups: incline first. Pull-ups: band-assisted or lat pulldown/row first.
- Knees and lower back take the load: box squats to a set depth, hinge with a trap bar or KB before a barbell from the floor.
- Heat tolerance is lower — fan, hydration, shorter intervals in warm rooms.
- Fat loss comes mostly from food; training's job is to keep (and build) muscle, improve fitness and health markers. Say this plainly when setting expectations.

## Musculoskeletal — spine, foot, wrist/elbow

### Lumbar disc protrusion / nerve-root compression / stenosis / degenerative disc disease
The spine is the joint most likely to end a program. Principles:

- **Find the directional preference.** Disc problems are usually aggravated by flexion (bending forward, sitting slumped); stenosis by extension (standing/walking long, arching back). When both are present, ask which positions provoke and which ease symptoms, and program toward the easing direction. Record the answer in the profile's injury entry.
- **Centralisation rule:** if an exercise sends symptoms further down the leg (buttock → thigh → below knee → foot), stop it. Back pain moving *toward* the spine is acceptable.
- **Avoid early:** loaded spinal flexion (sit-ups, crunches, toe touches, Jefferson curls, good mornings), heavy barbell back squats and floor deadlifts, jumping and running, loaded twisting, high-rep fatiguing hinges, heavy flexion within an hour of waking (discs are most hydrated then).
- **Build with:** McGill "big 3" (modified curl-up, side plank, bird dog), dead bug, glute bridge / hip thrust, hip-hinge patterning with a dowel, goblet box squat to a pain-free depth, split squats and step-ups, chest-supported rows, cable/band pulldowns, suitcase and farmer carries (excellent for the spine), sled, cycling (often well tolerated with stenosis), walking in tolerable doses, swimming.
- **Progression to heavier lifting** (trap-bar from blocks → trap-bar from floor; front/goblet squat → heavier) only after 4–6 weeks without leg symptoms, one variable at a time.
- **Nerve warning signs** — numbness, pins and needles, leg weakness (tripping, foot slapping): regress, and recommend medical review if new or worsening.
- **Emergency (cauda equina):** numbness in the groin/saddle area, new bladder or bowel changes, rapidly progressing leg weakness → emergency department immediately.

### Plantar fasciitis / heel pain
- Morning first-step pain is the gauge: if it's worse the morning after a session, the previous day's foot load was too high.
- High-load calf raise (towel under toes, 3 s up – 2 s hold – 3 s down, to ~12 RM, 3 sets, every other day) has good evidence; plus calf/soleus stretching.
- Supportive shoes for walking volume; avoid barefoot impact; increase walking/hiking volume ≤ 10 %/week.

### Wrist / elbow pain
- Ask what it is (tendinopathy, sprain, unknown) and which grip/position hurts.
- Neutral-grip options (dumbbells, neutral-grip handles, push-up handles instead of flat-palm push-ups), lifting straps to offload grip, avoid painful end-range extension under load.
- Tendons like slow, heavy-ish isometrics and eccentrics in the 0–3/10 pain range; they dislike sudden spikes in grip-heavy volume.

## Medications that change exercise

| Class (examples) | Effect | What to do |
|---|---|---|
| Beta-blockers (metoprolol, atenolol, propranolol) | Blunt heart rate | Don't use HR zones — use RPE / talk test. |
| ACE inhibitors / ARBs (lisinopril, losartan) | Dizziness on standing up quickly | Slow transitions floor → standing; longer cool-down. |
| Diuretics (HCTZ, furosemide) | Dehydration, electrolytes | Hydrate; cramps are a warning. |
| Statins | Occasional muscle pain | Unusual, persistent, non-training muscle pain → tell the doctor. |
| GLP-1 agonists (semaglutide, tirzepatide) | Appetite drops, lean-mass loss | Resistance training + protein target are non-negotiable. |
| Insulin, sulfonylureas | Hypoglycaemia | See glucose section. |
| Metformin | GI upset | No change to training. |
| SGLT2 inhibitors | Dehydration | Hydrate. |

## Red flags — stop the session, recommend medical help

Chest pain/pressure/tightness, pain spreading to arm/jaw; breathlessness out of proportion to effort; palpitations or irregular heartbeat; dizziness, fainting or near-fainting; sudden severe headache; one-sided weakness/numbness or slurred speech; calf pain with swelling; new joint pain that is sharp, worsening, or with swelling. Chest pain, fainting or stroke signs → emergency services, not "see a doctor this week".

## Labs — how to use them

Use the reference range printed in the record. Labs inform the *why* (e.g. "A1c 5.9 % in 2025 → resistance training and post-meal walks are a priority"), not session-to-session programming. Kidney function (eGFR < 60) matters for protein targets and hydration — defer protein advice to their doctor in that case. Thyroid out of range can explain fatigue and weight trends — mention, don't interpret.
