import { rebaseGraphGesture, type GraphGesture, type GraphConflict } from "../components/graphBandDraft";
import {
  cloneEditorProfile as cloneProfile,
  parseEditorProfile as parseProfile,
  editorProfilesEqual as profilesEqual,
  serializeEditorProfile as serializeProfile,
  emptyEditorDocument,
  type EditorProfile as Profile,
} from "./editorDocument";

export const WORKSPACE_KEY = "foosh.workspace.v1";
export const PRESETS_KEY = "foosh.presets.v1";
export const SETTINGS_KEY = "foosh.settings.v1";

export type History = {
  past: Profile[];
  present: Profile;
  future: Profile[];
  checkpoint: Profile | null;
};
export type HistoryAction =
  | { type: "set"; profile: Profile }
  | { type: "begin" }
  | { type: "end" }
  | { type: "undo" }
  | { type: "redo" };

export function createHistory(profile: Profile): History {
  return {
    past: [],
    present: cloneProfile(profile),
    future: [],
    checkpoint: null,
  };
}

export function historyReducer(state: History, action: HistoryAction): History {
  switch (action.type) {
    case "begin":
      return state.checkpoint
        ? state
        : { ...state, checkpoint: cloneProfile(state.present) };
    case "end": {
      if (!state.checkpoint) return state;
      const changed =
        state.present.id !== state.checkpoint.id ||
        !profilesEqual(state.present, state.checkpoint);
      return {
        ...state,
        checkpoint: null,
        past: changed
          ? [...state.past, state.checkpoint].slice(-80)
          : state.past,
        future: changed ? [] : state.future,
      };
    }
    case "set": {
      if (
        profilesEqual(state.present, action.profile) &&
        state.present.id === action.profile.id
      )
        return state;
      return {
        ...state,
        present: cloneProfile(action.profile),
        past: state.checkpoint
          ? state.past
          : [...state.past, state.present].slice(-80),
        future: state.checkpoint ? state.future : [],
      };
    }
    case "undo": {
      const settled = state.checkpoint
        ? historyReducer(state, { type: "end" })
        : state;
      if (!settled.past.length) return settled;
      return {
        past: settled.past.slice(0, -1),
        present: settled.past.at(-1)!,
        future: [settled.present, ...settled.future],
        checkpoint: null,
      };
    }
    case "redo": {
      const settled = state.checkpoint
        ? historyReducer(state, { type: "end" })
        : state;
      if (!settled.future.length) return settled;
      return {
        past: [...settled.past, settled.present].slice(-80),
        present: settled.future[0],
        future: settled.future.slice(1),
        checkpoint: null,
      };
    }
  }
}

export type Settings = {
  theme: "system" | "light" | "dark";
  reduceTransparency: boolean;
  showBandCurves: boolean;
};
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  reduceTransparency: false,
  showBandCurves: true,
};

export function readSettings(): Settings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      theme: ["system", "light", "dark"].includes(value.theme)
        ? value.theme
        : "system",
      reduceTransparency: value.reduceTransparency === true,
      showBandCurves: value.showBandCurves !== false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function readWorkspace(): Profile {
  try {
    const text = localStorage.getItem(WORKSPACE_KEY);
    if (text) return parseProfile(text);
  } catch {
    /* A corrupt draft must never prevent the app from opening. */
  }
  return emptyEditorDocument();
}

export function readPresets(): Profile[] {
  try {
    const values: unknown = JSON.parse(
      localStorage.getItem(PRESETS_KEY) || "[]",
    );
    if (!Array.isArray(values)) return [];
    const seen = new Set<string>();
    return values.slice(0, 100).flatMap((value) => {
      try {
        const profile = parseProfile(JSON.stringify(value));
        if (seen.has(profile.id)) return [];
        seen.add(profile.id);
        return [profile];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function persistWorkspace(profile: Profile): boolean {
  try {
    localStorage.setItem(WORKSPACE_KEY, serializeProfile(profile));
    return true;
  } catch {
    return false;
  }
}

export function persistPresets(profiles: Profile[]): boolean {
  try {
    localStorage.setItem(
      PRESETS_KEY,
      JSON.stringify(
        profiles.map((profile) => JSON.parse(serializeProfile(profile))),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

/** Commit a graph-owned preview against the latest document as one undo step. */
export function commitGraphGesture(state: History, gesture: GraphGesture): { history: History; conflicts: GraphConflict[] } {
  if (state.checkpoint) throw new Error("Finish the active history transaction before committing a graph gesture.");
  const rebased = rebaseGraphGesture(state.present, gesture);
  return { history: historyReducer(state, { type: "set", profile: rebased.profile }), conflicts: rebased.conflicts };
}
