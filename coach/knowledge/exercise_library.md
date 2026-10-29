# Exercise library: choosing, mixing and progressing exercises

The library is `coach/library.json` (228 exercises); `coach/library.py` reads it for one person. Use it when you write a plan, and it's what the rolling plan uses every day to rotate, swap and progress.

## What each exercise carries

| Field | Meaning |
|---|---|
| `pattern` | The movement it trains: `squat`, `lunge`, `hinge`, `push_h`, `push_v`, `pull_h`, `pull_v`, `carry`, `core_ext`, `core_rot`, `core_lat`, `core_flex`, `rotation`, `power`, `locomotion`, `arms`, `shoulder`, `lower_acc`, `grip`, `balance`, `mobility`, `conditioning`. Swaps stay inside a pattern, falling back to a related one only when nothing in the pattern is safe. |
| `family`, `level` | The progression ladder. Levels run 1–5: a family's level 1 is the gentlest entry, and level 5 is advanced calisthenics or heavy barbell work. Wall push-up (1) → incline (2) → push-up (3) → tempo (4) → archer (5). |
| `equipment` | What it needs. Each entry is required; a list inside means any one of those. Household items count as owned unless the person says otherwise (`limits.no_household`): wall, chair, stairs, towel, backpack, door frame, stick, cushion. |
| `styles` | `calisthenics`, `wall_floor` (needs nothing beyond the household), `conventional` (barbell, dumbbell, machines), `functional` (carries, kettlebells, get-ups, crawls), `unconventional` (backpack, towel, door, landmine, sled), `isometric`, `mobility`, `power`, `conditioning`, `rehab`. |
| `purposes` | What it's good for. Each purpose has a default dose in the library: `strength`, `hypertrophy`, `endurance`, `power`, `conditioning`, `core`, `balance`, `mobility`, `rehab`, `injury_prevention`, `posture`, `bone`, `bp`, `glucose`, `grip`, `warmup`, `recovery`, `athletic`. |
| `stresses` | What it loads, matched against limits and signals. Listed in the next section. |
| `implement` | The `load_steps` key it uses for weight. Exercises without one are bodyweight or ladder exercises. |
| `picture` | A catalogue id (`ek-…` Everkinetic, otherwise free-exercise-db), hand-checked. `null` means draw one or ask for a photo (see *Pictures* in the coach skill). |

### Stresses

Limits and signals use the same tags:
- `spine_axial`: compression down the spine (bar on the back, heavy overhead, heavy carries).
- `spine_flex_loaded`: bending the spine forward under load or many times.
- `spine_flex_end`: end-range forward bending without load.
- `spine_ext_end`: end-range back arching.
- `spine_rot_loaded`: twisting under load or fast.
- `spine_shear`: long-lever bent-over positions.
- `floor_lift`: lifting a load from the floor.
- `knee_deep`: loaded deep knee bend.
- `knee_open`: open-chain knee extension under load.
- `kneeling`: weight on the knees.
- `impact`: landing or running.
- `plantar`: high load through the foot and calf.
- `wrist_ext`: bodyweight on the hands with the wrist bent back.
- `grip_heavy`: heavy or long gripping.
- `overhead`: arms overhead under load.
- `shoulder_end`: loaded shoulder end range (dips, deep flyes, deficits).
- `hanging`: hanging from the arms.
- `high_pressure`: near-maximal efforts and hard bracing.
- `inverted`: head below the heart.
- `supine`, `prone`: lying on the back, or on the stomach.
- `floor_transition`: getting down to and up from the floor.
- `balance`: single-leg or unstable.
- `hip_deep`: deep hip bend.
- `ballistic`: fast or explosive.
- `end_stretch`: long passive end-range stretching.
- `neck`: load through the neck or head.

## The person's limits

`health_profile.json` → `limits`, written by the Coach during `/setup` (or whenever the profile changes) and confirmed with the person:

```json
"limits": {"avoid": ["spine_flex_loaded", "spine_rot_loaded"], "caution": ["knee_deep"], "max_level": 3, "no_household": ["table"]}
```

- **`avoid`:** never picked, and swapped out if a plan names one. That covers diagnoses with a clear rule (disc problems, osteoporosis: loaded flexion and twisting; hypertension: `high_pressure`) and anything a clinician has ruled out.
- **`caution`:** never picked automatically. Allowed only when the plan names the exercise itself, after the safety review. Use it for "maybe, carefully" (knee OA → `knee_deep`).
- **`max_level`:** the ceiling for automatic picks. Defaults from experience: none or beginner 2, returning 3, intermediate 4, advanced 5. Ladders may climb above it, one rung at a time, when the log proves it.

Start from `library.json` → `conditions`: each profile lists `avoid`, `caution`, `prefer`, notes and sources. It's general guidance; the person's own history decides. Turn injuries' `triggers` into stresses too, e.g. "kneeling" → `kneeling`, "reaching overhead" → `overhead`, "bending forward" → `spine_flex_loaded`.

## Writing a plan with the library

**Stable main lifts, rotating accessories.** Strength is built and measured on a few lifts done consistently: keep each session's 2–3 main lifts fixed for at least a phase (4–6 weeks). Everything else rotates every 2–4 weeks for variety, coverage and joint health. The 2026 ACSM position stand stresses individualisation, enjoyment and adherence over rigid templates; going from no resistance training to any is the biggest gain.

In a routine:

```json
{"ex": "goblet_squat", "sets": 3, "reps": "8–12", "load_kg": 12.5}
{"ex": "push_up", "sets": 3, "reps": "6–12"}
{"slot": {"pattern": "core_rot", "purpose": "core", "every_weeks": 3}, "sets": 2, "reps": {"reps": "6–10", "s": "20–30"}}
{"slot": {"pattern": "pull_v", "every_weeks": "phase", "from": ["band_pulldown", "feet_assisted_chin_up", "negative_pull_up"]}, "sets": 3, "reps": "5–8"}
```

- **`ex`** fixes an exercise. Name, picture, cues and stresses come from the library; you can still override `name`, `cues` or add `tags`.
- **`slot`** rotates:
  - `pattern` (required);
  - `purpose` (prefer these);
  - `styles` (prefer these);
  - `from` (a shortlist, in your order of preference);
  - `max_level`;
  - `every_weeks` (a number, or `"phase"`).

  Each block of weeks picks a different family. Use `from` when only a few options are right for this person.
- **Bodyweight exercises** (no `implement`) progress along their family automatically. Set `"ladder": false` to pin one.
- Check what a slot can pick: `python coach/library.py find <pattern> [purpose]`, `swap <id>`, `ladder <id>`. These use the person's equipment and limits.

**Mixes.** `library.json` → `mixes` holds session shapes to start from:
- `full_body_strength`;
- `upper_lower_upper` and `upper_lower_lower`;
- `anywhere_20`;
- `back_friendly`, `bp_friendly`, `knee_friendly_lower`;
- `bone_builder`, `falls_prevention`;
- `athletic_functional`;
- `injury_prevention`;
- `mobility_reset`, `warmup_ramp`;
- `conditioning_emom`.

Each lists slots as pattern, role (`main` fixed / `rotate` / `fixed` with a named exercise) and purpose, plus any stresses the mix avoids. Combine them, e.g. full-body strength three times a week, plus the injury-proofing add-on once a week.

**Cover the patterns across the week.** Aim for:
- squat, hinge, lunge, horizontal and vertical push and pull;
- a carry;
- anti-extension, anti-rotation and lateral core;
- balance, for anyone over 50 or with a falls history.

Add `bp` isometrics for high blood pressure, `bone` work for low bone density, and `injury_prevention` for runners and field-sport players.

## What the evidence says (short)

- **Low back and discs:**
  - In lab studies, repeated loaded flexion produces disc herniation (Callaghan & McGill 2001). Clinical trials, however, show most exercise types help back pain about equally (WHO 2023).
  - So: avoid loaded flexion and twisting for people with disc disease, build trunk endurance (curl-up, side plank, bird dog), and otherwise choose what they tolerate and enjoy. If an exercise sends symptoms further down the leg, stop it for the day.
  - Sources: [McGill](https://www.backfitpro.com/pdf/selecting_back_exercises.pdf), [flexion debate](https://www.greglehman.ca/blog/2016/01/31/revisiting-the-spinal-flexion-debate-prepare-for-doubt).
- **Blood pressure:**
  - Isometric training lowered resting BP the most of any training mode: −8.2/−4.0 mmHg across 270 RCTs (Edwards 2023, [BJSM](https://pubmed.ncbi.nlm.nih.gov/37491419/)). Wall sits and handgrip are the practical forms.
  - Breathe throughout and avoid near-maximal efforts while BP is high.
- **Osteoporosis:**
  - Avoid loaded forward bending and twisting of the spine ([BHOF](https://www.bonehealthandosteoporosis.org/patients/treatment/exercisesafe-movement/protecting-your-spine/)).
  - Progressive resistance and balance are the core of training. Supervised heavy lifting and impact improved bone in LIFTMOR, but only under supervision.
- **Knees:**
  - In knee OA, closed-chain work may help pain slightly more than open-chain in the short term ([2025 meta-analysis](https://onlinelibrary.wiley.com/doi/full/10.1002/pri.70105)).
  - In kneecap pain, both work long term ([Witvrouw](https://pubmed.ncbi.nlm.nih.gov/15262632/)).
  - Adjust depth to symptoms.
- **Shoulders:**
  - Progressive exercise works for rotator-cuff pain, and heavy isn't clearly better than light ([JOSPT 2025](https://www.jospt.org/doi/10.2519/jospt.2025.13182)).
  - Landmine and short-range incline pressing are gentler while it settles.
- **Plantar fasciitis:** heavy slow calf raises with a towel under the toes improved pain faster than stretching ([Rathleff 2015](https://pubmed.ncbi.nlm.nih.gov/25145882/)).
- **Injury prevention:**
  - The Nordic hamstring curl halves hamstring injuries ([van Dyk 2019](https://www.researchgate.net/publication/331367089)).
  - The Copenhagen plank builds adductor strength.
- **Falls:**
  - Balance and functional exercise cut falls by 24%; combined with resistance training, by 34% ([Cochrane 2019](https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858.CD012424.pub2/full)).
  - Work near a support, and practise getting up from the floor.
- **Pregnancy:** moderate resistance and aerobic work are recommended with the care provider's OK. Avoid contact and fall-risk sports, lying flat on the back for long late in pregnancy, and overheating (ACOG 804, 2020).
- **Hypermobility:** strength through a controlled mid-range, with closed-chain and isometric work first, and limited passive stretching ([feasibility study](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7350677/)).

Several condition notes rest on clinical consensus rather than trials. The library marks sources where they exist. When a person's clinician says otherwise, the clinician wins: write it into `restrictions.medical_advice` and `limits`.
