import { emptyEditorDocument, parseEditorProfile, parseEditorProfileStrict, serializeEditorProfile } from "./editorDocument";
import { createHistory, historyReducer, WORKSPACE_KEY, type History } from "./workspace";

export const HISTORY_KEY = "foosh.history.v1";
const MAX_BYTES = 1024 * 1024;
type Reader = Pick<Storage, "getItem">;
type Writer = Pick<Storage, "setItem">;

function checkSize(text: string): void {
  if (typeof text !== "string" || text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES)
    throw new Error("History must be at most 1 MiB of JSON text.");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function checkStacks(past: unknown, future: unknown): asserts past is unknown[] {
  if (!Array.isArray(past) || !Array.isArray(future) || past.length > 80 || future.length > 80 || past.length + future.length > 80)
    throw new Error("History may contain at most 80 saved steps.");
}

export function parseHistory(text: string): History {
  checkSize(text);
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.version !== 1 || !record(value.history) || Object.hasOwn(value.history, "checkpoint"))
    throw new Error("Invalid version 1 history session.");
  const history = value.history;
  checkStacks(history.past, history.future);
  const read = (entry: unknown) => parseEditorProfileStrict(JSON.stringify(entry));
  return {
    past: history.past.map(read),
    present: read(history.present),
    future: (history.future as unknown[]).map(read),
    checkpoint: null,
  };
}

export function serializeHistory(history: History): string {
  const settled = historyReducer(history, { type: "cancel" });
  checkStacks(settled.past, settled.future);
  const envelope = (profile: History["present"]) => {
    // Validate explicit metadata before the tolerant serializer can normalize it.
    if (profile.visibleBandIds !== undefined) {
      parseEditorProfileStrict(JSON.stringify({
        version: 1,
        profile,
        editor: { version: 1, visibleBandIds: profile.visibleBandIds },
      }));
    }
    return JSON.parse(serializeEditorProfile(profile));
  };
  const text = JSON.stringify({ version: 1, history: {
    past: settled.past.map(envelope),
    present: envelope(history.checkpoint ?? settled.present),
    future: settled.future.map(envelope),
  }});
  checkSize(text);
  // Also reject sparse arrays, which JSON would otherwise turn into null entries.
  parseHistory(text);
  return text;
}

export function readHistory(storage?: Reader): History {
  try {
    const text = (storage ?? localStorage).getItem(HISTORY_KEY);
    if (text !== null) return parseHistory(text);
  } catch { /* Try the independent legacy key, without migrating it. */ }
  try {
    const text = (storage ?? localStorage).getItem(WORKSPACE_KEY);
    if (text !== null) return createHistory(parseEditorProfile(text));
  } catch { /* Storage is optional. */ }
  return createHistory(emptyEditorDocument());
}

export function persistHistory(history: History, storage?: Writer): boolean {
  try {
    const text = serializeHistory(history);
    (storage ?? localStorage).setItem(HISTORY_KEY, text);
    return true;
  } catch {
    return false;
  }
}
