// The app's data on this phone: one document in SQLite (expo-sqlite's key-value store), loaded at start and saved
// shortly after every change. Conversations with the Coach are kept under their own key. Nothing leaves the phone
// except what the person sends to Claude, and a backup file they choose to share.

import Storage from "expo-sqlite/kv-store";
import { useMemo, useSyncExternalStore } from "react";

import type { Thread } from "../coach/agent.ts";
import { localToday } from "../../../shared/engine/util.ts";
import { lib, pictures } from "./catalog.ts";
import { STATE_VERSION, emptyState, schedule } from "../../../shared/model.ts";
import type { AppState } from "../../../shared/model.ts";

const STATE_KEY = "state", THREADS_KEY = "threads";

let state: AppState = emptyState();
let threads: Thread[] = [];
let loaded = false;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function migrate(raw: Partial<AppState>): AppState {
  const base = emptyState();
  return {
    ...base, ...raw,
    version: STATE_VERSION,
    settings: { ...base.settings, ...(raw.settings || {}),
      claude: { ...base.settings.claude, ...(raw.settings?.claude || {}) },
      sources: { ...base.settings.sources, ...(raw.settings?.sources || {}) },
      consent: { ...base.settings.consent, ...(raw.settings?.consent || {}) } },
  } as AppState;
}

export async function load(): Promise<void> {
  try {
    const raw = await Storage.getItem(STATE_KEY);
    state = raw ? migrate(JSON.parse(raw)) : emptyState();
    const t = await Storage.getItem(THREADS_KEY);
    threads = t ? JSON.parse(t) : [];
  } finally {
    loaded = true;
    listeners.forEach(l => l());
  }
}

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    Storage.setItem(STATE_KEY, JSON.stringify(state)).catch(() => undefined);
    Storage.setItem(THREADS_KEY, JSON.stringify(threads)).catch(() => undefined);
  }, 300);
}

export function getState(): AppState { return state; }

export function update(fn: (s: AppState) => AppState): void {
  state = fn(state);
  persist();
  listeners.forEach(l => l());
}

/** Replace everything (an import). */
export function replace(next: AppState): void {
  update(() => migrate(next));
}

export function getThreads(): Thread[] { return threads; }

export function saveThread(t: Thread): void {
  threads = [t, ...threads.filter(x => x.id !== t.id)].slice(0, 30);
  persist();
  listeners.forEach(l => l());
}

export function deleteThread(id: string): void {
  threads = threads.filter(x => x.id !== id);
  persist();
  listeners.forEach(l => l());
}

export async function eraseEverything(): Promise<void> {
  state = emptyState();
  threads = [];
  await Storage.removeItem(STATE_KEY);
  await Storage.removeItem(THREADS_KEY);
  listeners.forEach(l => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, () => state);
}

export function useLoaded(): boolean {
  return useSyncExternalStore(subscribe, () => loaded);
}

export function useThreads(): Thread[] {
  return useSyncExternalStore(subscribe, () => threads);
}

export function useToday(): string {
  // Re-read on every render; screens re-render on focus and on any change, which covers midnight well enough.
  return localToday();
}

export function useSchedule() {
  const s = useAppState();
  const today = useToday();
  return useMemo(() => {
    try { return { schedule: schedule(s, lib, today, pictures), error: null as string | null }; }
    catch (e) { return { schedule: null, error: (e as Error).message }; }
  }, [s, today]);
}
