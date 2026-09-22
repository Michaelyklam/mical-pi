import { readDeviceProfile, type DeviceSnapshot } from "./device";
import { editorDocument } from "./editorDocument";
import { historyReducer, type History } from "./workspace";

type CaptureState = {
  status: "idle" | "reading" | "ready" | "error";
  progress: string;
  snapshot: DeviceSnapshot | null;
  error: string;
};
const idle = (): CaptureState => ({ status: "idle", progress: "", snapshot: null, error: "" });
const copySnapshot = (snapshot: DeviceSnapshot): DeviceSnapshot => ({
  ...snapshot,
  profile: { ...snapshot.profile, bands: snapshot.profile.bands.map((band) => ({ ...band })) },
});

export function createDeviceCapture(reader: typeof readDeviceProfile = readDeviceProfile) {
  let state = idle();
  let generation = 0;
  let active: { controller: AbortController; finish: () => void; promise: Promise<void> } | null = null;
  function cancel(): void {
    generation += 1;
    const previous = active;
    active = null;
    state = idle();
    previous?.controller.abort(new Error("The device read was stopped."));
    previous?.finish();
  }
  function start(): Promise<void> {
    if (active) return active.promise;
    const token = ++generation;
    const controller = new AbortController();
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => { finish = resolve; });
    active = { controller, finish, promise };
    state = { ...idle(), status: "reading" };
    const failed = (error: unknown) => {
      if (generation === token) {
        state = { ...idle(), status: "error", error: error instanceof Error ? error.message : "Device read failed." };
        active = null;
      }
      finish();
    };
    try {
      // Do not defer this call: the real reader needs transient user activation.
      const pending = reader((progress) => {
        if (generation === token && state.status === "reading") state = { ...state, progress };
      }, { signal: controller.signal });
      Promise.resolve(pending).then((snapshot) => {
        if (generation === token) {
          state = { ...state, status: "ready", snapshot: copySnapshot(snapshot), error: "" };
          active = null;
        }
        finish();
      }).catch(failed);
    } catch (error) { failed(error); }
    return promise;
  }
  return {
    getState(): CaptureState {
      return { ...state, snapshot: state.snapshot ? copySnapshot(state.snapshot) : null };
    },
    start,
    cancel,
    dismiss: cancel,
    apply(history: History): History {
      if (state.status !== "ready" || !state.snapshot || history.checkpoint) return history;
      const profile = editorDocument({
        ...state.snapshot.profile,
        visibleBandIds: state.snapshot.profile.bands.map((band) => band.id),
      });
      const next = historyReducer(history, { type: "set", profile });
      cancel();
      return next;
    },
  };
}
