// The Coach's tools: reading the library, the plan and the logs, and proposing changes. They run on the phone,
// against the person's local data.

import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { ExerciseLibrary } from "../engine/library.ts";
import type { Schedule } from "../engine/rolling.ts";
import type { Obj } from "../engine/types.ts";
import { addDays } from "../engine/util.ts";
import type { AppState } from "../store/model.ts";
import { currentRecovery, workoutRows } from "../store/model.ts";
import { checkChanges, describe, needsReview, shapeErrors } from "./changes.ts";
import type { Change, Findings } from "./changes.ts";
import { compactSchedule } from "./prompts.ts";

export const TOOLS: BetaTool[] = [
  {
    name: "find_exercises",
    description: "Library exercises this person can do for a movement pattern, best fit first (goals, baseline focus, emphasis, their conditions' preferred exercises, their own adaptations, level; never equipment). Shows each one's level, fit score, what it loads the way they do it, and whether their equipment allows it. Set include_caution to also list exercises with a caution stress (a plan may name those in a slot's \"from\" list).",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A library pattern, e.g. push_h, hinge, core_rot." },
        purpose: { type: "string", description: "Optional purpose to rank for, e.g. strength, posture, rehab." },
        include_caution: { type: "boolean" },
        no_equipment: { type: "boolean", description: "Only what works with household items." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "get_exercise",
    description: "One library exercise in full: cues, stresses, equipment, unit, its progression ladder (family), and this person's adaptations for it.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_schedule",
    description: "The next days as the app's engine has laid them out (after recovery, check-ins, signals, the log and overrides), with each session's exercises, sets, reps and loads.",
    input_schema: { type: "object", properties: { days: { type: "integer", description: "1–14, default 14." } } },
  },
  {
    name: "get_history",
    description: "Logged data: workouts (one row per exercise), check-ins, calibration results, or the wearable's daily recovery rows.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["workouts", "checkins", "calibration", "wearable"] },
        days: { type: "integer", description: "How far back, default 42." },
      },
      required: ["kind"],
    },
  },
  {
    name: "propose_changes",
    description: "Propose changes to the plan or profile. The person sees them as one card and applies or declines it; an independent safety review runs before anything that changes exercises or intensity is applied. Local checks run now: if they block, nothing is shown and this returns what to fix. Change types: new_plan {plan: {name, program, rolling, routines, overrides}}, set_rolling {rolling}, set_routine {key, routine}, remove_routine {key}, set_override {date, override}, clear_override {date}, set_program {program}, set_limits {limits}, set_coaching {coaching}, set_adaptations {adaptations} (the full list), set_signals {signals} (the full list), set_goals {goals} (the full list), set_load_steps {load_steps}, set_calibration {calibration: {tests, batteries}}.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line for the card's title." },
        why: { type: "string", description: "Two or three sentences: what changes and the data behind it." },
        changes: { type: "array", items: { type: "object" }, description: "Each {type, ...fields}." },
      },
      required: ["summary", "why", "changes"],
    },
  },
];

export interface Proposal {
  id: string; summary: string; why: string; changes: Change[]; lines: string[]; local: Findings; review: boolean;
  confirm: string[];      // what it loosens: the person ticks that they've decided this themselves
  confirmed?: boolean;
  status: "pending" | "reviewing" | "applied" | "declined" | "blocked";
  verdict?: { verdict: string; blocking: string[]; warnings: string[]; missing_information: string[] };
  error?: string;
}

export interface ToolEnv { state: AppState; lib: ExerciseLibrary; sched: Schedule | null; today: string }

const slim = (x: unknown) => JSON.stringify(x);

export function runTool(name: string, input: Obj, env: ToolEnv, newProposal: (p: Proposal) => void): { content: string; is_error?: boolean } {
  const { state, lib, today } = env;
  const who = lib.person(state.profile.health_profile, state.profile.equipment, state.profile.goals);
  switch (name) {
    case "find_exercises": {
      if (!lib.data.patterns[input.pattern]) return { content: `Unknown pattern "${input.pattern}". Patterns: ${Object.keys(lib.data.patterns).join(", ")}`, is_error: true };
      const gear = input.no_equipment ? who.household : who.equipment;
      const slot = input.purpose ? { purpose: input.purpose } : {};
      const list = lib.data.exercises.filter(e => e.pattern === input.pattern)
        .filter(e => lib.usable(e, gear, who.avoid, 5, input.include_caution ? [] : who.caution, who))
        .map(e => ({ id: e.id, name: e.name, level: e.level, family: e.family, fit: lib.fit(e, who, slot),
          loads: [...lib.stresses(e, who, gear)], caution: [...lib.stresses(e, who, gear)].filter(s => who.caution.has(s)),
          above_level_cap: e.level > who.max_level, has_their_adaptation: lib.adaptationsFor(e, who).length > 0, unit: e.unit || "reps" }))
        .sort((a, b) => b.fit - a.fit || a.level - b.level).slice(0, 20);
      return { content: slim({ pattern: input.pattern, level_cap: who.max_level, exercises: list }) };
    }
    case "get_exercise": {
      const ex = lib.get(input.id);
      if (!ex) return { content: `No exercise "${input.id}" in the library.`, is_error: true };
      return { content: slim({ ...ex, loads_their_way: [...lib.stresses(ex, who, who.equipment)], their_adaptations: lib.adaptationsFor(ex, who),
        usable_with_their_equipment: lib.hasEquipment(ex, who.equipment), ladder: lib.ladder(ex.id).map(e => `${e.id} (L${e.level})`) }) };
    }
    case "get_schedule": {
      const n = Math.max(1, Math.min(14, Number(input.days) || 14));
      const c = compactSchedule(env.sched);
      return { content: c ? slim({ ...c, days: c.days.slice(0, n) }) : "No plan yet." };
    }
    case "get_history": {
      const since = addDays(today, -(Number(input.days) || 42));
      if (input.kind === "workouts") return { content: slim(workoutRows(state).filter(r => r.date >= since)) };
      if (input.kind === "checkins") return { content: slim(state.checkins.filter(c => c.date >= since)) };
      if (input.kind === "calibration") return { content: slim(state.assessments) };
      if (input.kind === "wearable") {
        const rec = currentRecovery(state, today);
        const rows = Object.fromEntries(Object.entries(state.daily).map(([k, v]) => [k, v.filter(r => r.date >= since)]));
        return { content: slim({ recovery: rec, rows }) };
      }
      return { content: `Unknown kind "${input.kind}".`, is_error: true };
    }
    case "propose_changes": {
      const errs = shapeErrors(input.changes);
      if (errs.length) return { content: "Not shown to the person. Fix the format:\n- " + errs.join("\n- "), is_error: true };
      const changes = input.changes as Change[];
      const { blocking, warnings, confirm } = checkChanges(state, changes, lib, today);
      if (blocking.length) {
        return { content: "Not shown to the person: the local checks block it. Fix these and propose again:\n- " + blocking.join("\n- ")
          + (warnings.length ? "\nAlso (warnings):\n- " + warnings.join("\n- ") : ""), is_error: true };
      }
      const p: Proposal = {
        id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        summary: String(input.summary || "Changes"), why: String(input.why || ""), changes, lines: changes.map(describe),
        local: { blocking, warnings }, review: needsReview(changes), status: "pending", confirm,
      };
      newProposal(p);
      return { content: `Shown to the person as a card ("${p.summary}"). ${p.review ? "A safety review runs when they tap Apply." : "No review needed."}`
        + (confirm.length ? ` It loosens their limits, so they must confirm it themselves: ${confirm.join(" ")}` : "")
        + (warnings.length ? ` Local warnings shown with it:\n- ${warnings.join("\n- ")}` : "") };
    }
  }
  return { content: `Unknown tool ${name}.`, is_error: true };
}
