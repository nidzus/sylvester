// Exercise library: choose, swap and progress exercises for one person.
// A line-for-line port of coach/library.py; see its docstring for what each function means.
// The catalogue (coach/library.json) is passed in, so the same code runs in the app and in tests.

import type { Adaptation, Exercise, Library, Obj, Person, Slot } from "./types.ts";
import { maxBy, minBy, pyRound, sortBy } from "./util.ts";

// Goal words (goals.json "type" and "title") -> library purposes. The main active goal counts double, a paused one a little.
export const GOAL_PURPOSES: [string, string[]][] = [
  ["strength", ["strength"]], ["muscle", ["hypertrophy"]], ["hypertroph", ["hypertrophy"]], ["tone", ["hypertrophy"]],
  ["mobility", ["mobility"]], ["flexib", ["mobility"]], ["stability", ["balance", "core"]], ["balance", ["balance"]],
  ["functional", ["athletic", "balance"]], ["endurance", ["endurance"]], ["cardio", ["conditioning"]],
  ["fat", ["conditioning", "glucose"]], ["weight", ["conditioning", "glucose"]], ["blood pressure", ["bp"]],
  ["bone", ["bone"]], ["posture", ["posture"]], ["back", ["injury_prevention", "rehab"]], ["injur", ["injury_prevention"]],
  ["fall", ["balance"]], ["sport", ["athletic", "power"]],
];
export const LEVEL_BY_EXPERIENCE: Record<string, number> = {
  "none": 2, "beginner (< 1 yr)": 2, "returning after a long break": 3, "intermediate (1–3 yrs)": 4, "advanced (3+ yrs)": 5,
};
// Equipment ids from what the setup records (item "kind", or words in the name).
export const KIND: Record<string, string[]> = {
  dumbbells: ["dumbbell"], kettlebells: ["kettlebell"], barbell: ["barbell"], rack: ["rack"], bench: ["bench"],
  pullup: ["pullup_bar"], bands: ["band"], rings: ["rings"], cable: ["cable"], box: ["box"],
  recovery: ["foam_roller"], dip: ["dip"], vest: ["vest"], ball: ["medball"], landmine: ["landmine"],
};
// Stresses a bodyweight ladder never climbs into on its own: a plan has to name such a rung.
export const RISKY = new Set(["impact", "ballistic", "high_pressure", "inverted"]);
// Where a swap may look when nothing in the same pattern is safe (closest first).
const FALLBACK: Record<string, string[]> = {
  core_flex: ["core_ext", "core_lat", "core_rot"], rotation: ["core_rot", "core_lat"],
  push_v: ["shoulder", "push_h"], pull_v: ["pull_h"], power: ["squat", "hinge"],
  carry: ["core_lat", "core_rot"], locomotion: ["core_ext"], conditioning: ["locomotion"],
};
const GYM_FULL = ["dumbbell", "kettlebell", "barbell", "rack", "bench", "pullup_bar", "cable", "machine", "box", "landmine", "dip",
  "medball", "band", "trap_bar", "ab_wheel", "bike", "rower", "treadmill", "elliptical", "foam_roller"];
const GYM_SMALL = ["dumbbell", "bench", "cable", "machine", "treadmill", "bike", "elliptical"];
const WORDS: [string, string][] = [
  ["trap bar", "trap_bar"], ["hex bar", "trap_bar"], ["dumbbell", "dumbbell"], ["kettlebell", "kettlebell"], ["barbell", "barbell"],
  ["rack", "rack"], ["squat stand", "rack"], ["bench", "bench"], ["pull-up", "pullup_bar"], ["pullup", "pullup_bar"],
  ["chin", "pullup_bar"], ["mini band", "mini_band"], ["band", "band"], ["ring", "rings"], ["trx", "rings"],
  ["suspension", "rings"], ["cable", "cable"], ["pulley", "cable"], ["lat pulldown", "cable"], ["landmine", "landmine"],
  ["dip", "dip"], ["box", "box"], ["vest", "vest"], ["medicine", "medball"], ["slam", "medball"], ["sled", "sled"],
  ["ab wheel", "ab_wheel"], ["foam", "foam_roller"], ["rope", "jump_rope"], ["bike", "bike"], ["rower", "rower"],
  ["rowing", "rower"], ["treadmill", "treadmill"], ["walking pad", "treadmill"], ["air bike", "air_bike"],
  ["elliptical", "elliptical"], ["smith", "machine"], ["leg press", "machine"], ["leg extension", "machine"],
];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class ExerciseLibrary {
  readonly data: Library;
  readonly byId: Record<string, Exercise>;

  constructor(data: Library) {
    this.data = data;
    this.byId = Object.fromEntries(data.exercises.map(e => [e.id, e]));
  }

  get(id: string | null | undefined): Exercise | undefined {
    return id ? this.byId[id] : undefined;
  }

  household(healthProfile?: Obj): Set<string> {
    const skip = new Set<string>(healthProfile?.limits?.no_household || []);
    return new Set(this.data.household.filter(h => !skip.has(h)));
  }

  /** Equipment ids from equipment.json (wizard kinds first, then words in item names). */
  equipmentOwned(equipment: Obj | null | undefined): Set<string> {
    const have = new Set<string>();
    for (const it of equipment?.items || []) {
      const kind = it.kind;
      if (kind === "gym") {
        for (const x of (it.name || "").includes("Commercial") ? GYM_FULL : GYM_SMALL) have.add(x);
      } else if (kind in KIND) {
        for (const x of KIND[kind]) have.add(x);
        if (kind === "bands" && String(it.spec || "").toLowerCase().includes("mini")) have.add("mini_band");
      }
      const text = `${it.name ?? ""} ${it.spec ?? ""}`.toLowerCase();
      if (kind === "cardio" || !kind) {
        for (const [word, eid] of WORDS) {
          if (new RegExp("\\b" + escape(word)).test(text)) have.add(eid); // word starts only: a heart-rate "strap" is no trap bar
        }
      }
    }
    return have;
  }

  /** {purpose: weight} from goals.json: the first active goal 2, other active goals 1, paused ones 0.5. */
  goalPurposes(goals: Obj | null | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    let first = true;
    for (const goal of goals?.goals || []) {
      const status = String(goal.status || "active").toLowerCase();
      if (status === "done" || status === "dropped") continue;
      const w = status === "paused" ? 0.5 : first ? 2 : 1;
      first = first && status === "paused";
      const text = `${goal.type ?? ""} ${goal.title ?? ""}`.toLowerCase();
      for (const [word, purposes] of GOAL_PURPOSES) {
        if (text.includes(word)) for (const x of purposes) out[x] = Math.max(out[x] ?? 0, w);
      }
    }
    return out;
  }

  person(healthProfile: Obj, equipment: Obj, goals: Obj): Person {
    const lim = healthProfile.limits || {};
    const coach = healthProfile.coaching || {};
    const exp = String(healthProfile.training_background?.experience || "").trim();
    const conds = this.data.conditions || {};
    const prefer = new Set<string>(coach.prefer || []);
    for (const c of lim.conditions || []) for (const id of conds[c]?.prefer || []) prefer.add(id);
    const house = this.household(healthProfile);
    const unused = new Set<string>(lim.unused || []);
    const gear = new Set([...this.equipmentOwned(equipment)].filter(x => !unused.has(x)));
    for (const h of house) gear.add(h);
    return {
      limits: lim,
      avoid: new Set(lim.avoid || []),
      caution: new Set(lim.caution || []),
      max_level: Math.trunc(Number(lim.max_level) || LEVEL_BY_EXPERIENCE[exp] || 2),
      equipment: gear,
      household: house,
      purposes: this.goalPurposes(goals),
      focus: [...(coach.focus || [])],
      emphasis: [...(coach.emphasis || [])],
      prefer,
      dislike: new Set(coach.dislike || []),
      adaptations: [...(healthProfile.adaptations || [])],
    };
  }

  /** The person's own ways of doing this exercise; one that needs gear applies only where that gear is at hand
   *  (equipment undefined: anywhere). */
  adaptationsFor(ex: Exercise, who?: Partial<Person> | null, equipment?: Set<string>): Adaptation[] {
    const out: Adaptation[] = [];
    for (const a of who?.adaptations || []) {
      if (a.needs?.length && equipment !== undefined && !a.needs.some(n => equipment.has(n))) continue;
      const m = a.match || {};
      if ((m.ids || []).includes(ex.id) || (m.families || []).includes(ex.family) || (m.patterns || []).includes(ex.pattern)) out.push(a);
    }
    return out;
  }

  /** What the exercise loads, the way this person does it with this equipment. */
  stresses(ex: Exercise, who?: Partial<Person> | null, equipment?: Set<string>): Set<string> {
    let s = new Set(ex.stresses || []);
    for (const a of this.adaptationsFor(ex, who, equipment)) {
      const removes = new Set(a.removes || []);
      s = new Set([...s].filter(x => !removes.has(x)));
      for (const x of a.adds || []) s.add(x);
    }
    return s;
  }

  /** How well an exercise serves this person here; higher is better. Equipment never counts. */
  fit(ex: Exercise, who?: Partial<Person> | null, slot?: Partial<Slot> | null): number {
    const w = who || {}, sl = slot || {};
    const purposes = new Set(ex.purposes || []);
    let score = sl.purpose !== undefined && purposes.has(sl.purpose) ? 3.0 : 0.0;
    for (const [x, wt] of Object.entries(w.purposes || {})) if (purposes.has(x)) score += wt;
    score += 1.5 * (w.focus || []).filter((f, i, a) => a.indexOf(f) === i && purposes.has(f)).length;
    score += (w.emphasis || []).includes(ex.pattern) ? 1.0 : 0.0;
    score += w.prefer?.has(ex.id) ? 2.0 : 0.0;
    score -= w.dislike?.has(ex.id) ? 6.0 : 0.0;
    score += this.adaptationsFor(ex, w).length ? 1.0 : 0.0; // a way of doing it that's known to work for them
    const cap = Math.min(w.max_level ?? 5, sl.max_level ?? 5);
    score -= 0.5 * Math.max(0, cap - ex.level); // the highest rung they're ready for progresses best
    score += ex.picture ? 0.25 : 0.0;
    return pyRound(score, 2);
  }

  hasEquipment(ex: Exercise, equipment: Set<string>): boolean {
    for (const req of ex.equipment || []) {
      const alts = Array.isArray(req) ? req : [req];
      if (!alts.some(a => equipment.has(a))) return false;
    }
    return true;
  }

  /** Can this exercise be picked automatically? (A plan may still name a caution exercise itself.) */
  usable(ex: Exercise, equipment: Set<string>, avoid: Iterable<string>, maxLevel = 5, caution: Iterable<string> = [],
         who?: Partial<Person> | null): boolean {
    const s = this.stresses(ex, who, equipment);
    const hit = (xs: Iterable<string>) => [...xs].some(x => s.has(x));
    return this.hasEquipment(ex, equipment) && !hit(avoid) && !hit(caution) && ex.level <= maxLevel;
  }

  /** What this person can do for a pattern, best fit first. */
  candidates(pattern: string, equipment: Set<string>, avoid: Iterable<string>, maxLevel = 5, purpose?: string | null,
             styles?: string[] | null, caution: Iterable<string> = [], only?: string[] | null, who?: Partial<Person> | null): Exercise[] {
    let out = this.data.exercises.filter(e => e.pattern === pattern && this.usable(e, equipment, avoid, maxLevel, caution, who));
    if (only?.length) out = out.filter(e => only.includes(e.id));
    if (styles?.length) {
      const st = out.filter(e => e.styles.some(x => styles.includes(x)));
      out = st.length ? st : out;
    }
    const slot = purpose ? { purpose } : {};
    return sortBy(out, e => [-this.fit(e, who, slot), e.level, e.id]);
  }

  /** Closest safe alternative: same family first, then one-sided for one-sided, then nearest level, then best fit;
   *  then the same pattern, then a related pattern (FALLBACK). */
  substitute(exId: string, equipment: Set<string>, avoid: Iterable<string>, maxLevel = 5, caution: Iterable<string> = [],
             preferLevel?: number | null, who?: Partial<Person> | null): Exercise | null {
    const ex = this.get(exId);
    if (!ex) return null;
    const lvl = preferLevel || Math.min(ex.level, maxLevel); // a barbell lift's level isn't a bodyweight one's
    const cap = Math.max(maxLevel, ex.level);
    let pool: Exercise[] = [];
    for (const pattern of [ex.pattern, ...(FALLBACK[ex.pattern] || [])]) {
      pool = this.data.exercises.filter(e => e.id !== exId && e.pattern === pattern
        && this.usable(e, equipment, avoid, e.family === ex.family ? cap : maxLevel, caution, who));
      if (pool.length) break;
    }
    if (!pool.length) return null;
    const exPurposes = new Set(ex.purposes);
    return minBy(pool, e => {
      const shared = e.purposes.filter((p, i, a) => a.indexOf(p) === i && exPurposes.has(p)).length;
      return [e.family !== ex.family, (e.unilateral ?? null) !== (ex.unilateral ?? null),
        Math.abs(e.level - lvl) + (e.level > lvl ? 0.5 : 0), -shared, -this.fit(e, who), e.picture == null, e.id];
    }) ?? null;
  }

  ladder(exId: string): Exercise[] {
    const ex = this.get(exId);
    return ex ? sortBy(this.data.exercises.filter(e => e.family === ex.family), e => [e.level, e.id]) : [];
  }

  /** The next usable exercise one rung harder (+1) or easier (-1) in the same family, or null. A caution stress the
   *  current exercise already carries (the plan named it) doesn't block; a new one does. */
  stepRung(exId: string, direction: number, equipment: Set<string>, avoid: Iterable<string>, maxLevel = 5,
           caution: Iterable<string> = [], who?: Partial<Person> | null): Exercise | null {
    const ex = this.get(exId);
    if (!ex) return null;
    const own = this.stresses(ex, who, equipment);
    const care = [...caution].filter(c => !own.has(c));
    const rungs = this.ladder(exId).filter(e => e.id !== exId && this.usable(e, equipment, avoid, maxLevel, care, who));
    if (direction > 0) {
      const up = rungs.filter(e => e.level > ex.level && ![...this.stresses(e, who, equipment)].some(x => !own.has(x) && RISKY.has(x)));
      const fresh = (e: Exercise) => [...this.stresses(e, who, equipment)].filter(x => !own.has(x)).length; // prefer the step that loads nothing new
      return minBy(up, e => [e.level, fresh(e), e.picture == null, e.id]) ?? null;
    }
    const down = rungs.filter(e => e.level < ex.level);
    return maxBy(down, e => [e.level, e.picture != null, e.id]) ?? null;
  }

  /** A rotating slot's exercise for this block of weeks: the best fits for this person, taking turns. */
  pick(slot: Slot, block: number, equipment: Set<string>, avoid: Iterable<string>, maxLevel = 5, caution: Iterable<string> = [],
       who?: Partial<Person> | null): Exercise | null {
    const named = new Set(slot.from || []);
    avoid = [...avoid, ...(slot.avoid || [])];
    caution = [...caution, ...(slot.caution || [])];
    const level = Math.min(maxLevel, slot.max_level ?? 5);
    let pool = this.data.exercises.filter(e => e.pattern === slot.pattern && (
      named.has(e.id) ? this.usable(e, equipment, avoid, 5, [], who)
        : (named.size === 0 && this.usable(e, equipment, avoid, level, caution, who))));
    if (slot.styles?.length && !named.size) {
      const st = pool.filter(e => e.styles.some(x => slot.styles!.includes(x)));
      pool = st.length ? st : pool;
    }
    if (!pool.length) return null;
    const score: Record<string, number> = Object.fromEntries(pool.map(e => [e.id, this.fit(e, who, slot)]));
    let choices: Exercise[];
    if (named.size) {
      choices = pool;
    } else {
      const best = new Map<string, Exercise>();
      for (const e of pool) { // one per family: its best-fitting rung (the ladder takes it from there)
        const b = best.get(e.family);
        if (!b || score[e.id] > score[b.id] || (score[e.id] === score[b.id] && e.level > b.level)) best.set(e.family, e);
      }
      choices = [...best.values()];
    }
    const from = slot.from || [];
    const order = (id: string) => (from.includes(id) ? from.indexOf(id) : from.length); // a tie goes to the plan's own order
    choices = sortBy(choices, e => [-score[e.id], order(e.id), e.id]);
    const top = choices.filter(e => score[e.id] >= score[choices[0].id] - (slot.margin ?? 2)).slice(0, slot.choices ?? 3);
    return top[((block % top.length) + top.length) % top.length];
  }
}
