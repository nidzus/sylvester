// Where things are, the same as core/paths.py: the app's shared files, and the person's data folder.
//
// The data folder is found, in order: the SYLVESTER_DATA environment variable (the Desktop extension sets it from
// its "data folder" setting, empty when left blank), ~/.sylvester.json {"data": "<folder>"} (written by
// `sylvester.py init`), ~/health-data.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The app's shared files: the repository (two levels above mcp/src), or app/ beside the extension's server/. */
export function appRoot(): string {
  const tries = [process.env.SYLVESTER_APP, resolve(HERE, "..", ".."), resolve(HERE, "..", "app")].filter(Boolean) as string[];
  for (const t of tries) if (existsSync(join(t, "coach", "library.json"))) return t;
  throw new Error(`Sylvester's exercise library wasn't found (looked in ${tries.join(", ")}).`);
}

export const POINTER = () => join(homedir(), ".sylvester.json");

const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** A setting that is empty, or still the unfilled placeholder, counts as not set. */
const given = (v: string | undefined) => (v && v.trim() && !v.includes("${") ? v.trim() : "");

export function dataRoot(): { path: string; how: "env" | "pointer" | "default" } {
  const env = given(process.env.SYLVESTER_DATA);
  if (env) return { path: resolve(expand(env)), how: "env" };
  try {
    const p = JSON.parse(readFileSync(POINTER(), "utf8").replace(/^﻿/, "")).data;
    if (typeof p === "string" && p) return { path: resolve(expand(p)), how: "pointer" };
  } catch { /* no pointer yet */ }
  return { path: join(homedir(), "health-data"), how: "default" };
}

/** Version of the data folder's layout (core/paths.py SCHEMA). A newer folder than this means: update the app. */
export const SCHEMA = 1;

export interface Paths {
  data: string; settings: string; profile: string; history: string; records: string; sources: string; plans: string;
  proposals: string; changes: string; logs: string;
}

export function layout(data: string): Paths {
  const plans = join(data, "plans");
  return {
    data,
    settings: join(data, "settings.json"),
    profile: join(data, "profile"),
    history: join(data, "profile", ".history"),
    records: join(data, "records"),
    sources: join(data, "sources"),
    plans,
    proposals: join(plans, "proposals"),
    changes: join(plans, "changes.jsonl"),
    logs: join(data, "logs"),
  };
}
