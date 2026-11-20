// What ships with the app: the exercise library, the calibration tests, picture links and the Coach's knowledge
// (copied from the repository by scripts/build-assets.mjs).

import type { Catalogue } from "../engine/calibration.ts";
import { ExerciseLibrary } from "../engine/library.ts";
import type { Library } from "../engine/types.ts";
import assessments from "../generated/assessments.json";
import { KNOWLEDGE } from "../generated/knowledge.ts";
import library from "../generated/library.json";
import picturesJson from "../generated/pictures.json";
import templates from "../generated/templates.json";

export interface Picture { name: string; credit: string; instructions: string[]; images: string[] }

export const lib = new ExerciseLibrary(library as unknown as Library);
export const sharedCatalogue = assessments as unknown as Catalogue;
export const pictures = picturesJson as Record<string, Picture>;
export const knowledge = KNOWLEDGE;
export const starterPlan = templates as unknown as { rolling: Record<string, unknown>; routines: Record<string, Record<string, unknown>> };
