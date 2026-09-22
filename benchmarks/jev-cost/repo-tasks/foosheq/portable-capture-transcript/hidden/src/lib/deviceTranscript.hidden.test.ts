import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { parseCaptureTranscript, serializeCaptureTranscript, verifyCaptureTranscript }: any = await import("./deviceTranscript").catch(() => ({}));
import * as deviceApi from "./device";
const { readDeviceCapture, readDeviceProfile } = deviceApi;
import capture from "./fixtures/protocol-micro-0.2.json";
import { deferred, setupHid, reply, offsetView, tick, observe } from "./benchmarkHid.hidden-helper";

const readAt = "2026-02-03T04:05:06.007Z";
function transcript(): any {
  const pass = [[128, 12, 0], ...Array.from({ length: 8 }, (_, i) => [128, 9, 0, 0, i, 0]), [128, 3, 0]];
  return {
    version: 1, device: { vendorId: 13058, productId: 49679, productName: "Protocol Micro" }, readAt,
    records: [...pass, ...pass].map(request => ({ reportId: 75, request: [...request], response: [...reply(Uint8Array.from(request))] })),
  };
}
function expected() {
  return {
    profile: {
      id: "protocol-micro-snapshot", name: "Protocol Micro snapshot",
      description: "Read-only EQ capture from Protocol Micro. The active slot is not available.", preamp: -5,
      bands: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, type: "peak", frequency: 777 + 173 * i, q: (193 + i) / 256, gain: (-897 + i) / 256, enabled: true })),
    },
    firmware: "0.2", slot: null, productName: "Protocol Micro", vendorId: 13058, productId: 49679, readAt,
  };
}
function set16(record: any, offset: number, value: number) {
  const bytes = Uint8Array.from(record.response); new DataView(bytes.buffer).setInt16(offset, value, true); record.response = [...bytes];
}
let rig: ReturnType<typeof setupHid>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(readAt)); rig = setupHid();
  for (const fn of [parseCaptureTranscript, serializeCaptureTranscript, verifyCaptureTranscript, readDeviceCapture]) expect(fn).toBeTypeOf("function");
});
afterEach(() => {
  expect(rig.hid.getDevices).not.toHaveBeenCalled();
  expect(rig.hid.count("disconnect")).toBe(0);
  expect(rig.device.count("inputreport")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("offline replay and canonical schema", () => {
  it("replays exact fixed-point readings with no browser, storage or clock dependency", () => {
    const access = vi.fn(() => { throw Error("Browser access forbidden"); });
    vi.stubGlobal("navigator", undefined); vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(globalThis, "navigator", { configurable: true, get: access });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: access });
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    expect(verifyCaptureTranscript(transcript())).toEqual(expected());
    expect(verifyCaptureTranscript(parseCaptureTranscript(serializeCaptureTranscript(transcript())))).toEqual(expected());
    expect(access).not.toHaveBeenCalled();
  });
  it("replays the repository's captured 63-byte reports despite different firmware tails", () => {
    const input = transcript();
    input.records.forEach((record: any, index: number) => {
      const command = record.request[1];
      const hex = command === 12 ? (index === 0 ? capture.firmwareAfterFirstFilterHex : capture.firmwareResponseHex) : command === 9 ? capture.filterResponseHex[record.request[4]] : capture.globalGainResponseHex;
      record.response = hex.split(" ").map((value: string) => parseInt(value, 16));
    });
    const result = verifyCaptureTranscript(input);
    expect(result.profile.preamp).toBe(0);
    expect(result.profile.bands.map(b => b.frequency)).toEqual([31, 62, 125, 250, 500, 1000, 2000, 4000]);
    expect(result.profile.bands.every(b => b.q === 0.75 && b.gain === 0)).toBe(true);
    expect(result.slot).toBeNull();
    expect(parseCaptureTranscript(serializeCaptureTranscript(input))).toEqual(input);
  });
  it("copies arrays and strips only undocumented extras without discarding raw tails", () => {
    const input = transcript();
    input.extra = "drop"; input.device.serialNumber = "drop"; input.records[0].extra = "drop";
    input.records[10].response[30] = 222; input.records[11].response[7] = 137; input.records[11].response[35] = 7;
    const canonical = parseCaptureTranscript(serializeCaptureTranscript(input));
    expect(Object.keys(canonical).sort()).toEqual(["device", "readAt", "records", "version"]);
    expect(Object.keys(canonical.device).sort()).toEqual(["productId", "productName", "vendorId"]);
    expect(Object.keys(canonical.records[0]).sort()).toEqual(["reportId", "request", "response"]);
    expect(canonical.records[10].response[30]).toBe(222);
    expect(canonical.records[11].response[35]).toBe(7);
    expect(verifyCaptureTranscript(canonical)).toEqual(expected());
    const replay = verifyCaptureTranscript(input);
    input.records[1].response[27] = 0;
    expect(replay.profile.bands[0].frequency).toBe(777);
    expect(canonical.records[1].response[27]).toBe(9);
    canonical.records[0].request[0] = 0;
    expect(input.records[0].request[0]).toBe(128);
  });
  it.each([null, [], {}, { ...transcript(), version: 2 }, { ...transcript(), records: [] }, { ...transcript(), device: { ...transcript().device, vendorId: 13059 } }, { ...transcript(), device: { ...transcript().device, productId: 49680 } }, { ...transcript(), device: { vendorId: 13058, productId: 49679, productName: "protocol micro" } }].map(input => ({ input })))("rejects malformed schema: %#", ({ input }) => {
    expect(() => verifyCaptureTranscript(input as any)).toThrow();
    expect(() => serializeCaptureTranscript(input as any)).toThrow();
    expect(() => parseCaptureTranscript(JSON.stringify(input))).toThrow();
  });
  it.each(["not a date", "2026-02-03", "2026-02-03T04:05:06Z", "2026-02-03T04:05:06.007+00:00", "2026-02-30T04:05:06.007Z", 1770000000000, null])("requires canonical UTC readAt: %s", (date) => {
    const input = transcript(); input.readAt = date;
    expect(() => verifyCaptureTranscript(input)).toThrow();
  });
  it("enforces UTF-8 file size, including whitespace, before parsing", () => {
    const valid = serializeCaptureTranscript(transcript());
    expect(() => parseCaptureTranscript(" ".repeat(32768) + valid)).toThrow();
    const unicode = JSON.stringify({ ...transcript(), extra: "😀".repeat(8500) });
    expect(unicode.length).toBeLessThan(32768);
    expect(() => parseCaptureTranscript(unicode)).toThrow();
    expect(() => parseCaptureTranscript("{")).toThrow();
  });
});

describe("ordered read-only transcript validation", () => {
  const cases: [string, (input: any) => void][] = [
    ["missing record", t => t.records.pop()],
    ["extra record", t => t.records.push(t.records[0])],
    ["duplicate record", t => { t.records[2] = t.records[1]; }],
    ["reordered pass", t => { [t.records[0], t.records[10]] = [t.records[10], t.records[0]]; [t.records[1], t.records[2]] = [t.records[2], t.records[1]]; }],
    ["write opcode", t => { t.records[0].request[0] = 0; }],
    ["bulk command", t => { t.records[0].request[1] = 0x10; }],
    ["request padding", t => { t.records[0].request.push(0); }],
    ["wrong report", t => { t.records[0].reportId = 76; }],
    ["wrong response opcode", t => { t.records[0].response[0] = 0; }],
    ["wrong response command", t => { t.records[0].response[1] = 3; }],
    ["wrong response index", t => { t.records[1].response[4] = 7; }],
    ["short firmware", t => { t.records[0].response = t.records[0].response.slice(0, 5); }],
    ["short filter", t => { t.records[1].response = t.records[1].response.slice(0, 33); }],
    ["short global", t => { t.records[9].response = t.records[9].response.slice(0, 4); }],
    ["oversized response", t => { t.records[0].response = [...t.records[0].response, 0, 0]; }],
    ["non-byte", t => { t.records[0].response[20] = 256; }],
    ["fractional byte", t => { t.records[0].response[20] = 0.5; }],
    ["negative byte", t => { t.records[0].response[20] = -1; }],
    ["NaN byte", t => { t.records[0].response[20] = NaN; }],
    ["infinite byte", t => { t.records[0].response[20] = Infinity; }],
    ["boolean byte", t => { t.records[0].response[20] = false; }],
    ["string byte", t => { t.records[0].response[20] = "0"; }],
    ["sparse response", t => { delete t.records[0].response[20]; }],
    ["sparse request", t => { delete t.records[0].request[2]; }],
    ["unsupported firmware", t => { t.records[0].response[5] = 51; }],
    ["firmware changed", t => { t.records[10].response[5] = 51; }],
    ["frequency changed", t => set16(t.records[11], 27, 778)],
    ["Q changed one bit", t => set16(t.records[11], 29, 194)],
    ["gain changed one bit", t => set16(t.records[11], 31, -896)],
    ["global changed", t => { t.records[19].response[4] = 252; }],
    ["nonpeak", t => { t.records[1].response[33] = 3; }],
    ["zero frequency", t => set16(t.records[1], 27, 0)],
    ["Q outside decoder range", t => set16(t.records[1], 29, 25)],
    ["gain outside decoder range", t => set16(t.records[1], 31, 2561)],
    ["editor frequency outside range", t => { set16(t.records[1], 27, 20001); set16(t.records[11], 27, 20001); }],
    ["editor preamp outside range", t => { t.records[9].response[4] = 1; t.records[19].response[4] = 1; }],
  ];
  it.each(cases)("rejects %s in verify, parse and serialize", (_name, mutate) => {
    const input = transcript(); mutate(input);
    expect(() => verifyCaptureTranscript(input)).toThrow();
    expect(() => serializeCaptureTranscript(input)).toThrow();
    expect(() => parseCaptureTranscript(JSON.stringify(input))).toThrow();
  });
  it("accepts exact minimum and maximum payload lengths and inclusive ranges", () => {
    for (const size of ["minimum", "maximum"]) {
      const t = transcript();
      t.records.forEach((r: any) => {
        const command = r.request[1];
        if (command === 9) { set16(r, 27, r.request[4] % 2 ? 20 : 20000); set16(r, 29, 26); set16(r, 31, -2560); }
        if (command === 3) r.response[4] = 236;
        r.response = size === "minimum" ? r.response.slice(0, command === 12 ? 6 : command === 9 ? 34 : 5) : [...r.response, 255];
      });
      const result = verifyCaptureTranscript(t);
      expect(result.profile.preamp).toBe(-20);
      expect(result.profile.bands.every(b => b.q === 26 / 256 && b.gain === -10)).toBe(true);
      expect(result.slot).toBeNull();
    }
  });
});

describe("live mocked capture records only accepted responses", () => {
  it("captures two passes, own DataView ranges and immutable first replies; replays offline", async () => {
    rig.device.respond = packet => {
      const good = reply(packet);
      rig.device.emit(good, 76);
      rig.device.emit(good, 75, {});
      const wrong = good.slice(); wrong[1] = 99; rig.device.emit(wrong);
      if (packet[1] === 9) { const index = good.slice(); index[4] = (packet[4] + 1) % 8; rig.device.emit(index); }
      const view = offsetView(good);
      rig.device.emit(view);
      new Uint8Array(view.buffer).fill(255); // mutate the incoming buffer immediately after dispatch
      const duplicate = good.slice(); duplicate.fill(255, 3); rig.device.emit(duplicate);
    };
    const result = await readDeviceCapture();
    expect(result.snapshot).toEqual(expected()); expect(result.transcript).toEqual(transcript());
    expect(result.transcript.records).toHaveLength(20);
    expect(rig.device.packets).toHaveLength(20); expect(rig.device.close).toHaveBeenCalledTimes(1);
    expect(verifyCaptureTranscript(parseCaptureTranscript(serializeCaptureTranscript(result.transcript)))).toEqual(result.snapshot);
    result.transcript.records[1].response[27] = 0;
    expect(result.snapshot.profile.bands[0].frequency).toBe(777);
  });
  it("shares the concurrency guard with snapshot-only calls and keeps the chooser synchronous", async () => {
    const selection = deferred<any[]>(); rig.hid.requestDevice.mockReturnValueOnce(selection.promise);
    const progress = vi.fn(); const first = observe(readDeviceCapture(progress));
    expect(rig.hid.requestDevice).toHaveBeenCalledTimes(1); expect(progress).not.toHaveBeenCalled();
    await expect(readDeviceProfile()).rejects.toThrow(/already in progress/);
    await expect(readDeviceCapture()).rejects.toThrow(/already in progress/);
    selection.resolve([]); await first.done; expect(first.state.status).toBe("rejected");
    const profile = await readDeviceProfile(); expect(profile).toEqual(expected());
    expect(profile).not.toHaveProperty("transcript");
  });
  it("waits for successful send completion and handle close before returning a transcript", async () => {
    const sending = deferred(); const closing = deferred();
    rig.device.respond = packet => { rig.device.emit(reply(packet)); if (rig.device.packets.length === 1) return sending.promise; };
    rig.device.close.mockImplementationOnce(async () => { await closing.promise; rig.device.opened = false; });
    const pending = observe(readDeviceCapture()); await tick();
    expect(rig.device.packets).toHaveLength(1); expect(pending.state.status).toBe("pending");
    sending.resolve(); await tick(); expect(rig.device.packets).toHaveLength(20);
    expect(pending.state.status).toBe("pending"); closing.resolve(); await pending.done;
    expect(pending.state.status).toBe("resolved"); expect(pending.state.value!.transcript).toEqual(transcript());
  });
  it.each(["mismatch", "send failure", "close failure", "disconnect"])("does not expose a partial transcript after %s", async (mode) => {
    rig.device.respond = packet => {
      const bytes = reply(packet);
      if (mode === "mismatch" && rig.device.packets.length === 12) bytes[31] ^= 1;
      rig.device.emit(bytes);
      if (mode === "send failure") throw Error("synthetic send error");
      if (mode === "disconnect") rig.hid.disconnect();
    };
    if (mode === "close failure") rig.device.close.mockRejectedValueOnce(Error("synthetic close error"));
    const pending = observe(readDeviceCapture()); await pending.done;
    expect(pending.state.status).toBe("rejected"); expect(pending.state).not.toHaveProperty("value");
    expect(rig.device.close).toHaveBeenCalledTimes(1);
    expect(rig.device.count("inputreport")).toBe(0);
  });
});
