// The app's shared files, read once: the exercise library, the calibration tests, the knowledge modules, and the
// names of the picture catalogue's exercises (old-style plan entries name a picture rather than a library id).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Catalogue } from "../../shared/engine/calibration.ts";
import { ExerciseLibrary } from "../../shared/engine/library.ts";
import type { Library } from "../../shared/engine/types.ts";
import { appRoot } from "./paths.ts";

export interface Catalog {
  root: string;
  lib: ExerciseLibrary;
  assessments: Catalogue;
  knowledge: Record<string, string>;
  pictures: Record<string, { name?: string }>;
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));

let cached: Catalog | null = null;

export function catalog(): Catalog {
  if (cached) return cached;
  const root = appRoot();
  const knowledge: Record<string, string> = {};
  const kdir = join(root, "coach", "knowledge");
  for (const f of readdirSync(kdir).filter(f => f.endsWith(".md")).sort()) {
    knowledge[f.replace(/\.md$/, "")] = readFileSync(join(kdir, f), "utf8");
  }
  // Only the names are needed, as mobile/scripts/build-assets.mjs builds them for the phone.
  const pictures: Record<string, { name?: string }> = {};
  const free = join(root, "coach", "exercises", "exercises.json");
  if (existsSync(free)) for (const x of readJson(free)) pictures[x.id] = { name: x.name };
  const ek = join(root, "coach", "exercises", "everkinetic.json");
  if (existsSync(ek)) for (const x of readJson(ek)) if (x.img) pictures["ek-" + x.name] = { name: x.title };
  cached = {
    root,
    lib: new ExerciseLibrary(readJson(join(root, "coach", "library.json")) as Library),
    assessments: readJson(join(root, "coach", "assessments.json")) as Catalogue,
    knowledge,
    pictures,
  };
  return cached;
}
