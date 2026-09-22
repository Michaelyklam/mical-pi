import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDeviceProfile } from "./device";
const { createDeviceCapture }: any = await import("./deviceCapture").catch(() => ({}));
import { createHistory, historyReducer } from "./workspace";
import { addEditorBand, emptyEditorDocument } from "./editorDocument";
import { cloneProfile, FLAT_PROFILE } from "./eq";
import { deferred, setupHid, reply, tick, observe } from "./benchmarkHid.hidden-helper";

let rig: ReturnType<typeof setupHid>;
beforeEach(() => { vi.useFakeTimers(); rig = setupHid(); });
afterEach(() => {
  expect(rig.hid.getDevices).not.toHaveBeenCalled();
  expect(rig.hid.count("disconnect")).toBe(0);
  expect(rig.device.count("inputreport")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const read = (signal: AbortSignal, progress?: (text: string) => void) => readDeviceProfile(progress, { signal });
function snapshot() {
  const profile = cloneProfile(FLAT_PROFILE);
  profile.id = "protocol-micro-snapshot"; profile.preamp = -5;
  profile.bands[0] = { ...profile.bands[0], q: 193 / 256, gain: -897 / 256 };
  return { profile, firmware: "0.2", slot: null, productName: "Protocol Micro", vendorId: 13058, productId: 49679, readAt: "2026-01-02T03:04:05.000Z" };
}

describe("external read cancellation at transport boundaries", () => {
  it("pre-abort never opens a chooser, even with a non-Error reason", async () => {
    const error = new Error("Cancelled before click");
    const controller = new AbortController(); controller.abort(error);
    const first = observe(read(controller.signal)); await first.done;
    expect(first.state.status).toBe("rejected"); expect(first.state.reason).toBe(error);
    const second = new AbortController(); second.abort("stop");
    await expect(read(second.signal)).rejects.toBeInstanceOf(Error);
    expect(rig.hid.requestDevice).not.toHaveBeenCalled();
    expect(rig.device.open).not.toHaveBeenCalled();
  });
  it.each(["resolve", "reject"])("cancels a pending chooser promptly and ignores late %s", async (late) => {
    const selection = deferred<any[]>(); rig.hid.requestDevice.mockReturnValueOnce(selection.promise);
    const controller = new AbortController(); const reason = new Error("chooser stopped");
    const pending = observe(read(controller.signal));
    expect(rig.hid.requestDevice).toHaveBeenCalledTimes(1); // synchronous user-activation path
    controller.abort(reason); await tick();
    const early = { ...pending.state };
    if (late === "resolve") selection.resolve([rig.device]); else selection.reject(Error("late chooser rejection"));
    await pending.done; await tick();
    expect(early.status).toBe("rejected"); expect(early.reason).toBe(reason);
    expect(rig.device.open).not.toHaveBeenCalled();
    expect(rig.device.close).not.toHaveBeenCalled();
    await expect(readDeviceProfile()).resolves.toMatchObject({ slot: null });
  });
  it("releases the busy guard before an abandoned chooser settles", async () => {
    const selection = deferred<any[]>(); rig.hid.requestDevice.mockReturnValueOnce(selection.promise);
    const controller = new AbortController();
    const abandoned = observe(read(controller.signal)); controller.abort(Error("abandoned")); await tick();
    const retry = observe(readDeviceProfile()); await retry.done;
    // Settle the abandoned chooser before assertions, even on the baseline.
    selection.resolve([rig.device]); await abandoned.done; await tick();
    expect(retry.state.status).toBe("resolved");
    expect(abandoned.state.status).toBe("rejected");
    expect(rig.device.open).toHaveBeenCalledTimes(1);
    expect(rig.device.close).toHaveBeenCalledTimes(1);
  });
  it.each(["resolve", "reject"])("cancels a pending open and handles late %s safely", async (late) => {
    const opening = deferred();
    rig.device.open.mockImplementationOnce(async () => { await opening.promise; rig.device.opened = true; });
    const controller = new AbortController(); const reason = Error("open stopped");
    const pending = observe(read(controller.signal)); await tick();
    controller.abort(reason); await tick(); const early = { ...pending.state };
    if (late === "resolve") opening.resolve(); else opening.reject(Error("late open rejected"));
    await pending.done; await tick();
    expect(early.status).toBe("rejected"); expect(early.reason).toBe(reason);
    expect(rig.device.sendReport).not.toHaveBeenCalled();
    expect(rig.device.close).toHaveBeenCalledTimes(late === "resolve" ? 1 : 0);
    expect(rig.device.opened).toBe(false);
  });
  it.each([false, true])("cancels a waiting send/reply, including a reply before send completion (%s)", async (replyFirst) => {
    const sending = deferred();
    rig.device.respond = (packet) => { if (replyFirst) rig.device.emit(reply(packet)); return sending.promise; };
    const controller = new AbortController(); const reason = Error("send stopped");
    const pending = observe(read(controller.signal)); await tick();
    controller.abort(reason); await tick(); const early = { ...pending.state };
    sending.reject(Error("late send failed"));
    await pending.done; await tick();
    expect(early.status).toBe("rejected"); expect(early.reason).toBe(reason);
    expect(rig.device.packets).toHaveLength(1);
    expect(rig.device.close).toHaveBeenCalledTimes(1);
  });
  it("honors cancellation inside progress without sending the next request", async () => {
    const controller = new AbortController(); const reason = Error("stop at boundary");
    await expect(read(controller.signal, message => { if (message === "Reading filter 1 of 8, pass 1 of 2.") controller.abort(reason); })).rejects.toBe(reason);
    expect(rig.device.packets).toHaveLength(1);
    expect(rig.device.close).toHaveBeenCalledTimes(1);
  });
  it("waits for close but suppresses success when cancelled during close", async () => {
    const closing = deferred(); rig.device.close.mockImplementationOnce(async () => { await closing.promise; rig.device.opened = false; });
    const controller = new AbortController(); const reason = Error("close stopped");
    const pending = observe(read(controller.signal)); await tick();
    expect(rig.device.packets).toHaveLength(20);
    expect(rig.device.close).toHaveBeenCalledTimes(1);
    controller.abort(reason); await tick(); expect(pending.state.status).toBe("pending");
    closing.resolve(); await pending.done;
    expect(pending.state.status).toBe("rejected"); expect(pending.state.reason).toBe(reason);
  });
  it("bounds close cleanup after cancellation and releases the guard", async () => {
    rig.device.close.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController(); const reason = Error("stop while closing");
    const pending = observe(read(controller.signal)); await tick(); controller.abort(reason);
    await vi.advanceTimersByTimeAsync(500); await pending.done;
    expect(pending.state.status).toBe("rejected");
    expect(pending.state.reason).toBe(reason);
    // Simulate physical release in the fake; no real handle is touched.
    rig.device.opened = false;
    await expect(readDeviceProfile()).resolves.toMatchObject({ slot: null });
  });
  it("removes the caller's abort listener on success and errors without closing foreign handles", async () => {
    for (const opened of [false, true]) {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, "addEventListener");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      rig.device.opened = opened;
      const count = rig.device.close.mock.calls.length;
      const pending = observe(read(controller.signal)); await pending.done;
      if (opened) expect(rig.device.close).toHaveBeenCalledTimes(count);
      const listener = add.mock.calls.find(([name]) => name === "abort")?.[1];
      expect(listener).toBeTypeOf("function");
      expect(remove).toHaveBeenCalledWith("abort", listener);
      const calls = rig.device.close.mock.calls.length;
      controller.abort(); await tick();
      expect(rig.device.close).toHaveBeenCalledTimes(calls);
    }
  });
});

describe("staged capture owns generations, not workspace state", () => {
  beforeEach(() => expect(createDeviceCapture).toBeTypeOf("function"));
  it("starts synchronously, deduplicates in-flight starts and stages a detached result", async () => {
    const completion = deferred<any>(); let progress!: (text: string) => void; let signal!: AbortSignal;
    const reader = vi.fn((callback, options) => { progress = callback; signal = options.signal; return completion.promise; });
    const control = createDeviceCapture(reader);
    expect(control.getState()).toEqual({ status: "idle", progress: "", snapshot: null, error: "" });
    const pending = control.start();
    expect(reader).toHaveBeenCalledTimes(1); expect(signal).toBeInstanceOf(AbortSignal);
    control.start(); expect(reader).toHaveBeenCalledTimes(1);
    progress("pass one"); expect(control.getState().progress).toBe("pass one");
    const value = snapshot(); completion.resolve(value); await pending;
    value.profile.bands[0].gain = 9;
    const state = control.getState(); expect(state.status).toBe("ready");
    expect(state.snapshot!.profile.bands[0].gain).toBe(-897 / 256);
    state.snapshot!.profile.bands[0].q = 9;
    expect(control.getState().snapshot!.profile.bands[0].q).toBe(193 / 256);
    progress("late progress after completion"); expect(control.getState().progress).toBe("pass one");
    expect(rig.hid.requestDevice).not.toHaveBeenCalled();
  });
  it.each(["resolve", "reject"])("invalidates cancelled callbacks and stale %s across a restart", async (late) => {
    const first = deferred<any>(); const second = deferred<any>();
    const callbacks: any[] = []; const signals: AbortSignal[] = [];
    const reader = vi.fn((progress, options) => { callbacks.push(progress); signals.push(options.signal); return signals.length === 1 ? first.promise : second.promise; });
    const control = createDeviceCapture(reader);
    const old = control.start(); control.cancel(); await old;
    expect(signals[0].aborted).toBe(true); expect(control.getState().status).toBe("idle");
    const current = control.start(); callbacks[1]("new progress"); callbacks[0]("old progress");
    if (late === "resolve") first.resolve(snapshot()); else first.reject(Error("stale failure"));
    await tick(); expect(control.getState()).toMatchObject({ status: "reading", progress: "new progress", error: "", snapshot: null });
    second.resolve(snapshot()); await current;
    expect(control.getState().status).toBe("ready");
    expect(signals[1].aborted).toBe(false);
    control.dismiss(); expect(control.getState().status).toBe("idle");
  });
  it.each([Error("specific failure"), "non-error"])("failure settles start and dismiss clears it: %s", async (error) => {
    const control = createDeviceCapture(vi.fn(async () => { throw error; }));
    await expect(control.start()).resolves.toBeUndefined();
    expect(control.getState()).toEqual({ status: "error", error: error instanceof Error ? error.message : "Device read failed.", snapshot: null, progress: "" });
    control.dismiss(); expect(control.getState().status).toBe("idle");
    const sync = createDeviceCapture((() => { throw Error("sync failure"); }) as any);
    await expect(sync.start()).resolves.toBeUndefined(); expect(sync.getState().error).toBe("sync failure");
  });
  it("applies only ready snapshots as one undo step and preserves slot visibility through undo", async () => {
    const forbidden = vi.fn(() => { throw Error("Storage must not be touched"); });
    vi.stubGlobal("localStorage", { getItem: forbidden, setItem: forbidden });
    const previous = addEditorBand(emptyEditorDocument(), 2500);
    previous.bands[0].enabled = false;
    const history = createHistory(previous);
    const control = createDeviceCapture(async () => snapshot());
    expect(control.apply(history)).toBe(history);
    await control.start(); expect(history.present).toEqual(previous);
    const active = historyReducer(history, { type: "begin" });
    expect(control.apply(active)).toBe(active); expect(control.getState().status).toBe("ready");
    const imported = control.apply(historyReducer(active, { type: "end" }));
    expect(imported.past).toHaveLength(1);
    expect(imported.present.visibleBandIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(imported.present.bands[0]).toMatchObject({ gain: -897 / 256, q: 193 / 256 });
    expect(historyReducer(imported, { type: "undo" }).present).toEqual(previous);
    expect(control.getState().status).toBe("idle"); expect(control.apply(imported)).toBe(imported);
    await control.start(); expect(control.apply(imported)).toBe(imported); expect(control.getState().status).toBe("idle");
    expect(forbidden).not.toHaveBeenCalled(); expect(rig.hid.requestDevice).not.toHaveBeenCalled();
  });
  it("default reader stages a real mocked two-pass capture without auto-importing", async () => {
    const control = createDeviceCapture(); const history = createHistory(emptyEditorDocument());
    await control.start(); expect(control.getState().status).toBe("ready");
    expect(rig.device.packets).toHaveLength(20); expect(rig.device.close).toHaveBeenCalledTimes(1);
    expect(history.past).toHaveLength(0); expect(history.present.visibleBandIds).toEqual([]);
    expect(control.apply(history).present.bands[0].gain).toBe(-897 / 256);
  });
});
