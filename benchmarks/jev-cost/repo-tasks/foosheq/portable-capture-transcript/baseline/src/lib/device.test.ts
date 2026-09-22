// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __deviceTest, isWebHidSupported, readDeviceProfile } from "./device";
import capture from "./fixtures/protocol-micro-0.2.json";

// Default fixtures are synthetic. A separate regression below replays captured
// WebHID reports. No tests open real hardware or infer slots from report tails.
const REPORT_ID = 0x4b;
const FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000];

function dataView(bytes: Uint8Array, offset = 0): DataView {
  const buffer = new Uint8Array(bytes.length + offset + 8).fill(0xee);
  buffer.set(bytes, offset);
  return new DataView(buffer.buffer, offset, bytes.length);
}

function firmwareReply(version = "0.2"): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x80, 0x0c, 0x00]);
  bytes.set(
    Array.from(version, (character) => character.charCodeAt(0)),
    3,
  );
  return bytes;
}

function filterReply(index = 0): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x80, 0x09, 0x00, 0x00, index, 0x00, 0x00]);
  const data = new DataView(bytes.buffer);
  data.setUint16(27, FREQUENCIES[index] ?? 1000, true);
  data.setUint16(29, 192, true);
  data.setInt16(31, 0, true);
  bytes[33] = 2;
  return bytes;
}

function globalReply(gain = 0): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x80, 0x03, 0x02, 0x00]);
  new DataView(bytes.buffer).setInt8(4, gain);
  return bytes;
}

function replyFor(packet: Uint8Array): Uint8Array {
  switch (packet[1]) {
    case 0x0c:
      return firmwareReply();
    case 0x09:
      return filterReply(packet[4]);
    case 0x03:
      return globalReply();
    default:
      throw new Error(
        "The fake received a command outside the read allowlist.",
      );
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class TrackedTarget extends EventTarget {
  readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();
  maxInputListeners = 0;

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, callback, options);
    if (callback) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(callback);
      this.listeners.set(type, listeners);
      if (type === "inputreport")
        this.maxInputListeners = Math.max(
          this.maxInputListeners,
          listeners.size,
        );
    }
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, callback, options);
    if (callback) this.listeners.get(type)?.delete(callback);
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function collection(
  input: number[] = [],
  output: number[] = [],
  children: HIDCollectionInfo[] = [],
): HIDCollectionInfo {
  return {
    inputReports: input.map((reportId) => ({ reportId })),
    outputReports: output.map((reportId) => ({ reportId })),
    children,
  };
}

let allDevices: FakeDevice[];

class FakeDevice extends TrackedTarget {
  vendorId = 0x3302;
  productId = 0xc20f;
  productName = "Protocol Micro";
  opened = false;
  collections = [
    collection(
      [],
      [],
      [collection([], [], [collection([REPORT_ID], [REPORT_ID])])],
    ),
  ];
  readonly sent: { reportId: number; bytes: number[] }[] = [];
  respond: (packet: Uint8Array) => void | Promise<void> = (packet) => {
    this.emit(replyFor(packet));
  };
  open = vi.fn(async () => {
    this.opened = true;
  });
  close = vi.fn(async () => {
    this.opened = false;
  });
  sendReport = vi.fn(
    (reportId: number, source: BufferSource): Promise<void> => {
      const bytes = ArrayBuffer.isView(source)
        ? new Uint8Array(
            source.buffer,
            source.byteOffset,
            source.byteLength,
          ).slice()
        : new Uint8Array(source).slice();
      this.sent.push({ reportId, bytes: Array.from(bytes) });
      expect(this.opened).toBe(true);
      expect(this.count("inputreport")).toBe(1);
      return Promise.resolve(this.respond(bytes));
    },
  );

  constructor() {
    super();
    allDevices.push(this);
  }
  asDevice(): HIDDevice {
    return this as unknown as HIDDevice;
  }

  emit(
    bytes: Uint8Array | DataView,
    reportId = REPORT_ID,
    source: FakeDevice = this,
  ): void {
    this.dispatchEvent(
      Object.assign(new Event("inputreport"), {
        device: source.asDevice(),
        reportId,
        data: bytes instanceof DataView ? bytes : dataView(bytes),
      }),
    );
  }
}

class FakeHid extends TrackedTarget {
  devices: FakeDevice[];
  getDevices = vi.fn(() => {
    throw new Error("Enumeration is forbidden in these tests.");
  });
  requestDevice = vi.fn(
    async (_options?: HIDDeviceRequestOptions): Promise<HIDDevice[]> =>
      this.devices.map((device) => device.asDevice()),
  );
  constructor(device: FakeDevice) {
    super();
    this.devices = [device];
  }
  disconnect(device: FakeDevice): void {
    this.dispatchEvent(
      Object.assign(new Event("disconnect"), { device: device.asDevice() }),
    );
  }
}

let device: FakeDevice;
let hid: FakeHid;

beforeEach(() => {
  vi.useFakeTimers();
  allDevices = [];
  device = new FakeDevice();
  hid = new FakeHid(device);
  vi.stubGlobal("navigator", { hid });
});

afterEach(() => {
  expect(hid.getDevices).not.toHaveBeenCalled();
  expect(hid.count("disconnect")).toBe(0);
  for (const fake of allDevices) {
    expect(fake.count("inputreport")).toBe(0);
    expect(fake.maxInputListeners).toBeLessThanOrEqual(1);
  }
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function expectClosed(): void {
  expect(device.close).toHaveBeenCalledTimes(1);
  expect(device.opened).toBe(false);
  expect(device.count("inputreport")).toBe(0);
  expect(hid.count("disconnect")).toBe(0);
}

describe("optional WebHID access", () => {
  it("does not even inspect navigator.hid on import", async () => {
    const access = vi.fn(() => {
      throw new Error("Hardware access on import is forbidden.");
    });
    vi.stubGlobal(
      "navigator",
      Object.defineProperty({}, "hid", { get: access }),
    );
    vi.resetModules();
    await import("./device");
    expect(access).not.toHaveBeenCalled();
    expect(device.open).not.toHaveBeenCalled();
  });

  it("checks support without requesting or opening a device", () => {
    expect(isWebHidSupported()).toBe(true);
    expect(hid.requestDevice).not.toHaveBeenCalled();
    expect(device.open).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { hid: {} }])(
    "explains unsupported browsers without hardware access (%j)",
    async (navigatorValue) => {
      vi.stubGlobal("navigator", navigatorValue);
      expect(isWebHidSupported()).toBe(false);
      await expect(readDeviceProfile()).rejects.toThrow(
        /Safari and Firefox.*desktop Chrome or Edge.*offline/,
      );
      expect(hid.requestDevice).not.toHaveBeenCalled();
    },
  );

  it("requests the exact device filter synchronously before progress callbacks", async () => {
    const selection = deferred<HIDDevice[]>();
    hid.requestDevice.mockReturnValueOnce(selection.promise);
    const progress = vi.fn();
    const pending = readDeviceProfile(progress);
    expect(hid.requestDevice).toHaveBeenCalledExactlyOnceWith({
      filters: [{ vendorId: 0x3302, productId: 0xc20f }],
    });
    expect(progress).not.toHaveBeenCalled();
    selection.resolve([]);
    await expect(pending).rejects.toThrow(/No device selected.*offline/);
    expect(device.open).not.toHaveBeenCalled();
  });

  it.each(["NotFoundError", "AbortError"])(
    "handles chooser cancellation (%s)",
    async (name) => {
      hid.requestDevice.mockRejectedValueOnce(
        new DOMException("Browser detail", name),
      );
      await expect(readDeviceProfile()).rejects.toThrow(
        /No device selected.*offline/,
      );
      expect(device.open).not.toHaveBeenCalled();
    },
  );

  it.each(["NotAllowedError", "SecurityError"])(
    "explains chooser permission failures (%s)",
    async (name) => {
      hid.requestDevice.mockImplementationOnce(() => {
        throw new DOMException("Browser detail", name);
      });
      await expect(readDeviceProfile()).rejects.toThrow(
        /access was not allowed.*HTTPS.*Read device button/,
      );
      expect(device.open).not.toHaveBeenCalled();
    },
  );

  it.each([
    { vendorId: 0x3303 },
    { productId: 0xc210 },
    { productName: "Protocol Max" },
    { productName: "protocol micro" },
    { productName: "Protocol Micro " },
  ])("rejects an unverified identity before opening (%j)", async (identity) => {
    Object.assign(device, identity);
    await expect(readDeviceProfile()).rejects.toThrow(
      /selected device is not supported/,
    );
    expect(device.open).not.toHaveBeenCalled();
    expect(device.sendReport).not.toHaveBeenCalled();
    expect(device.close).not.toHaveBeenCalled();
  });

  it("chooses a nested bidirectional EQ collection, not another composite interface", async () => {
    const other = new FakeDevice();
    other.collections = [collection([REPORT_ID], [])];
    hid.devices = [other, device];
    await expect(readDeviceProfile()).resolves.toMatchObject({ slot: null });
    expect(other.open).not.toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
    expectClosed();
  });

  it.each([
    { collections: [] },
    { collections: [collection([REPORT_ID], [])] },
    { collections: [collection([], [REPORT_ID])] },
    { collections: [collection([0x4c], [0x4c])] },
    { collections: [collection([REPORT_ID]), collection([], [REPORT_ID])] },
    { collections: [{}] },
  ])(
    "requires both EQ report directions in a collection (%j)",
    async ({ collections }) => {
      device.collections = collections;
      await expect(readDeviceProfile()).rejects.toThrow(
        /did not expose.*EQ interface/,
      );
      expect(device.open).not.toHaveBeenCalled();
    },
  );

  it("rejects ambiguous interfaces without opening either one", async () => {
    const other = new FakeDevice();
    hid.devices.push(other);
    await expect(readDeviceProfile()).rejects.toThrow(
      /More than one compatible/,
    );
    expect(device.open).not.toHaveBeenCalled();
    expect(other.open).not.toHaveBeenCalled();
  });

  it("does not use or close a handle it did not open", async () => {
    device.opened = true;
    await expect(readDeviceProfile()).rejects.toThrow(/already open/);
    expect(device.open).not.toHaveBeenCalled();
    expect(device.close).not.toHaveBeenCalled();
    expect(device.sendReport).not.toHaveBeenCalled();
  });

  it("rejects concurrent captures and releases the guard after cancellation", async () => {
    const selection = deferred<HIDDevice[]>();
    hid.requestDevice.mockReturnValueOnce(selection.promise);
    const first = readDeviceProfile();
    await expect(readDeviceProfile()).rejects.toThrow(/already in progress/);
    expect(hid.requestDevice).toHaveBeenCalledTimes(1);
    selection.resolve([]);
    await expect(first).rejects.toThrow(/No device selected/);
    await expect(readDeviceProfile()).resolves.toMatchObject({ slot: null });
    expect(hid.requestDevice).toHaveBeenCalledTimes(2);
    expectClosed();
  });
});

describe("read allowlist and verification", () => {
  it("imports captured 63-byte reports with different firmware tails on each pass", async () => {
    let firmwareReads = 0;
    device.respond = (packet) => {
      const hex =
        packet[1] === 0x0c
          ? ++firmwareReads === 1
            ? capture.firmwareAfterFirstFilterHex
            : capture.firmwareResponseHex
          : packet[1] === 0x09
            ? capture.filterResponseHex[packet[4]!]!
            : capture.globalGainResponseHex;
      const reply = Uint8Array.from(hex.split(" "), (value) =>
        parseInt(value, 16),
      );
      expect(reply).toHaveLength(capture.payloadBytes);
      device.emit(dataView(reply, 9));
    };
    const snapshot = await readDeviceProfile();
    expect(snapshot.firmware).toBe(capture.firmware);
    expect(snapshot.profile.preamp).toBe(capture.expectedGlobalGain);
    expect(snapshot.profile.bands).toEqual(
      capture.expectedFrequencies.map((frequency, index) => ({
        id: index + 1,
        type: "peak",
        frequency,
        gain: capture.expectedBandGain,
        q: capture.expectedQ,
        enabled: true,
      })),
    );
    expect(snapshot.slot).toBeNull();
    expect(device.sent).toHaveLength(20);
    expect(
      device.sent.every(
        ({ reportId, bytes }) => reportId === REPORT_ID && bytes[0] === 0x80,
      ),
    ).toBe(true);
    expectClosed();
  });

  it("returns a verified snapshot with slot null using only allowlisted reads and closes the handle", async () => {
    vi.setSystemTime(new Date("2026-09-04T23:00:00.000Z"));
    const progress = vi.fn();
    const snapshot = await readDeviceProfile(progress);
    expect(snapshot).toEqual({
      profile: {
        id: "protocol-micro-snapshot",
        name: "Protocol Micro snapshot",
        description:
          "Read-only EQ capture from Protocol Micro. The active slot is not available.",
        preamp: 0,
        bands: FREQUENCIES.map((frequency, index) => ({
          id: index + 1,
          type: "peak",
          frequency,
          gain: 0,
          q: 0.75,
          enabled: true,
        })),
      },
      firmware: "0.2",
      slot: null,
      productName: "Protocol Micro",
      vendorId: 0x3302,
      productId: 0xc20f,
      readAt: "2026-09-04T23:00:00.000Z",
    });
    const pass = [
      [0x80, 0x0c, 0x00],
      ...Array.from({ length: 8 }, (_, index) => [
        0x80,
        0x09,
        0x00,
        0x00,
        index,
        0x00,
      ]),
      [0x80, 0x03, 0x00],
    ];
    expect(device.sent).toEqual(
      [...pass, ...pass].map((bytes) => ({ reportId: REPORT_ID, bytes })),
    );
    expect(progress).toHaveBeenCalledWith("Reading global gain, pass 2 of 2.");
    expectClosed();
    hid.disconnect(device);
    expect(device.close).toHaveBeenCalledTimes(1);
  });

  it("preserves every verified band and signed global gain without rounding or offsets", async () => {
    device.respond = (packet) => {
      const reply = packet[1] === 0x03 ? globalReply(-5) : replyFor(packet);
      if (packet[1] === 0x09) {
        const index = packet[4]!;
        const view = new DataView(reply.buffer);
        view.setUint16(27, 1000 + index, true);
        view.setUint16(29, 193 + index, true);
        view.setInt16(31, -897 + index, true);
      }
      device.emit(reply);
    };
    const snapshot = await readDeviceProfile();
    expect(snapshot.slot).toBeNull();
    expect(snapshot.profile.preamp).toBe(-5);
    expect(snapshot.profile.bands).toEqual(
      FREQUENCIES.map((_, index) => ({
        id: index + 1,
        type: "peak",
        frequency: 1000 + index,
        q: (193 + index) / 256,
        gain: (-897 + index) / 256,
        enabled: true,
      })),
    );
    expect(device.sent).toHaveLength(20);
    expectClosed();
  });

  it.each([
    { frequency: 19, preamp: 0 },
    { frequency: 20001, preamp: 0 },
    { frequency: 1000, preamp: 1 },
    { frequency: 1000, preamp: -21 },
  ])(
    "rejects complete snapshots outside editor ranges without clamping (%j)",
    async ({ frequency, preamp }) => {
      device.respond = (packet) => {
        const reply =
          packet[1] === 0x03 ? globalReply(preamp) : replyFor(packet);
        if (packet[1] === 0x09 && packet[4] === 7) {
          new DataView(reply.buffer).setUint16(27, frequency, true);
        }
        device.emit(reply);
      };
      await expect(readDeviceProfile()).rejects.toThrow(
        "The device settings exceed the editor ranges. Frequency must be 20-20000 Hz and preamp must be -20 to 0 dB. No profile was imported.",
      );
      expect(device.sent).toHaveLength(20);
      expectClosed();
    },
  );

  it.each([
    { frequency: 20, preamp: -20 },
    { frequency: 20, preamp: 0 },
    { frequency: 20000, preamp: -20 },
    { frequency: 20000, preamp: 0 },
  ])(
    "accepts complete snapshots at the inclusive editor boundaries (%j)",
    async ({ frequency, preamp }) => {
      device.respond = (packet) => {
        const reply =
          packet[1] === 0x03 ? globalReply(preamp) : replyFor(packet);
        if (packet[1] === 0x09)
          new DataView(reply.buffer).setUint16(27, frequency, true);
        device.emit(reply);
      };
      const snapshot = await readDeviceProfile();
      expect(snapshot.slot).toBeNull();
      expect(snapshot.profile.preamp).toBe(preamp);
      expect(snapshot.profile.bands.map((band) => band.frequency)).toEqual(
        Array(8).fill(frequency),
      );
      expect(device.sent).toHaveLength(20);
      expectClosed();
    },
  );

  it("waits for send completion even if the correlated reply arrives synchronously", async () => {
    const sending = deferred<void>();
    device.respond = (packet) => {
      device.emit(replyFor(packet));
      if (device.sent.length === 1) return sending.promise;
    };
    const assertion = expect(readDeviceProfile()).resolves.toMatchObject({
      slot: null,
    });
    await tick();
    expect(device.sent).toHaveLength(1);
    sending.resolve();
    await assertion;
    expect(device.sent).toHaveLength(20);
    expectClosed();
  });

  it("ignores immediate duplicate replies rather than consuming the next transaction", async () => {
    device.respond = (packet) => {
      device.emit(replyFor(packet));
      const duplicate = replyFor(packet);
      duplicate.fill(0xff, 3);
      device.emit(duplicate);
      queueMicrotask(() => device.emit(duplicate));
    };
    await expect(readDeviceProfile()).resolves.toMatchObject({ slot: null });
    expect(device.sent).toHaveLength(20);
    expectClosed();
  });

  it.each([
    "report",
    "opcode",
    "command",
    "index",
    "device",
    "short header",
  ] as const)("does not consume a reply with the wrong %s", async (field) => {
    const waitingForFilter = field === "index";
    let current!: Uint8Array;
    device.respond = (packet) => {
      if (waitingForFilter && packet[1] === 0x0c) device.emit(replyFor(packet));
      else current = packet;
    };
    let settled = false;
    const pending = readDeviceProfile().finally(() => {
      settled = true;
    });
    const assertion = expect(pending).resolves.toMatchObject({ slot: null });
    await tick();
    const count = device.sent.length;
    const wrong = replyFor(current);
    if (field === "opcode") wrong[0] = 0x00;
    if (field === "command") wrong[1] = 0x03;
    if (field === "index") wrong[4] = 7;
    device.emit(
      field === "short header" ? wrong.slice(0, 1) : wrong,
      field === "report" ? 0x4c : REPORT_ID,
      field === "device" ? new FakeDevice() : device,
    );
    await tick();
    expect(settled).toBe(false);
    expect(device.sent).toHaveLength(count);
    device.respond = (packet) => {
      device.emit(replyFor(packet));
    };
    device.emit(replyFor(current));
    await assertion;
    expect(device.sent).toHaveLength(20);
    expectClosed();
  });

  it("does not save unsolicited future filter replies for later reads", async () => {
    device.respond = (packet) => {
      if (packet[1] === 0x09 && packet[4] === 0) device.emit(filterReply(1));
      if (!(packet[1] === 0x09 && packet[4] === 1))
        device.emit(replyFor(packet));
    };
    const assertion =
      expect(readDeviceProfile()).rejects.toThrow(/Timed out reading/);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(device.sent).toHaveLength(3);
    expectClosed();
  });

  it("honors response DataView offsets and minimum lengths", async () => {
    device.respond = (packet) => {
      const length = packet[1] === 0x0c ? 6 : packet[1] === 0x09 ? 34 : 5;
      device.emit(dataView(replyFor(packet).slice(0, length), 11));
    };
    await expect(readDeviceProfile()).resolves.toMatchObject({ slot: null });
    expect(device.sent).toHaveLength(20);
    expectClosed();
  });

  it.each([
    [0x0c, 5],
    [0x09, 33],
    [0x09, 4],
    [0x03, 4],
  ])(
    "rejects a truncated matching reply (command %i, length %i)",
    async (command, length) => {
      device.respond = (packet) => {
        const reply = replyFor(packet);
        device.emit(packet[1] === command ? reply.slice(0, length) : reply);
      };
      await expect(readDeviceProfile()).rejects.toThrow(
        /incomplete read response/,
      );
      expectClosed();
    },
  );

  it.each(["0.1", "0.3", "x.y", "0.0"])(
    "rejects unsupported firmware %s before reading filters",
    async (firmware) => {
      device.respond = () => {
        device.emit(firmwareReply(firmware));
      };
      await expect(readDeviceProfile()).rejects.toThrow(
        /Only Protocol Micro firmware 0.2/,
      );
      expect(device.sent).toHaveLength(1);
      expectClosed();
    },
  );

  it.each([6, 7, 10, 33, 62])(
    "ignores nonzero bytes at report offset %i outside the fixed firmware field",
    async (offset) => {
      device.respond = (packet) => {
        const reply = replyFor(packet);
        if (packet[1] === 0x0c) reply[offset] = 0x41;
        device.emit(reply);
      };
      await expect(readDeviceProfile()).resolves.toMatchObject({
        firmware: "0.2",
      });
      expectClosed();
    },
  );

  it("requires identical firmware on the second pass", async () => {
    device.respond = (packet) => {
      device.emit(
        packet[1] === 0x0c && device.sent.length > 10
          ? firmwareReply("0.3")
          : replyFor(packet),
      );
    };
    await expect(readDeviceProfile()).rejects.toThrow(
      /firmware reads did not match/,
    );
    expect(device.sent).toHaveLength(11);
    expectClosed();
  });

  it.each([27, 29, 31])(
    "rejects even a one-bit change in filter metadata at byte %i",
    async (offset) => {
      device.respond = (packet) => {
        const reply = replyFor(packet);
        if (packet[1] === 0x09 && device.sent.length > 10)
          reply[offset] = reply[offset]! ^ 1;
        device.emit(reply);
      };
      await expect(readDeviceProfile()).rejects.toThrow(
        /filter reads did not match/,
      );
      expect(device.sent).toHaveLength(12);
      expectClosed();
    },
  );

  it("requires identical global gain, including zero on the first pass", async () => {
    device.respond = (packet) => {
      device.emit(
        packet[1] === 0x03 && device.sent.length > 10
          ? globalReply(-1)
          : replyFor(packet),
      );
    };
    await expect(readDeviceProfile()).rejects.toThrow(
      /global gain reads did not match/,
    );
    expect(device.sent).toHaveLength(20);
    expectClosed();
  });

  it.each([0, 101, 7])(
    "does not infer slot %i from stable per-filter padding",
    async (padding) => {
      device.respond = (packet) => {
        const reply = replyFor(packet);
        if (packet[1] === 0x09) reply[35] = padding;
        device.emit(reply);
      };
      await expect(readDeviceProfile()).resolves.toMatchObject({ slot: null });
      expect(device.sent).toHaveLength(20);
      expectClosed();
    },
  );

  it("compares normalized values, not coefficients or unverified slot bytes", async () => {
    device.respond = (packet) => {
      const reply = replyFor(packet);
      if (packet[1] === 0x09 && device.sent.length > 10) {
        reply.fill(0xee, 7, 27);
        reply[35] = packet[4]!;
      }
      device.emit(reply);
    };
    await expect(readDeviceProfile()).resolves.toMatchObject({ slot: null });
    expect(device.sent).toHaveLength(20);
    expectClosed();
  });

  it.each(["type", "frequency", "q", "gain"] as const)(
    "rejects invalid %s metadata and closes",
    async (field) => {
      device.respond = (packet) => {
        const reply = replyFor(packet);
        if (packet[1] === 0x09) {
          const view = new DataView(reply.buffer);
          if (field === "type") reply[33] = 0xff;
          if (field === "frequency") view.setUint16(27, 0xffff, true);
          if (field === "q") view.setUint16(29, 0, true);
          if (field === "gain") view.setInt16(31, 11 * 256, true);
        }
        device.emit(reply);
      };
      await expect(readDeviceProfile()).rejects.toThrow(
        field === "type" ? /Only peak/ : /invalid or unsupported/,
      );
      expect(device.sent).toHaveLength(2);
      expectClosed();
    },
  );
});

describe("deadlines, disconnects, and cleanup", () => {
  it.each([0x0c, 0x09, 0x03])(
    "times out command %i and removes every listener",
    async (command) => {
      device.respond = (packet) => {
        if (packet[1] !== command) device.emit(replyFor(packet));
      };
      const assertion =
        expect(readDeviceProfile()).rejects.toThrow(/Timed out reading/);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
      expectClosed();
    },
  );

  it("times out a pending send even when its response arrived", async () => {
    device.respond = (packet) => {
      device.emit(replyFor(packet));
      return new Promise(() => {});
    };
    const assertion =
      expect(readDeviceProfile()).rejects.toThrow(/Timed out reading/);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(device.sent).toHaveLength(1);
    expectClosed();
  });

  it("rejects promptly on target disconnect but ignores another device disconnect", async () => {
    device.respond = () => {};
    const assertion =
      expect(readDeviceProfile()).rejects.toThrow(/was disconnected/);
    await tick();
    hid.disconnect(new FakeDevice());
    await tick();
    expect(device.count("inputreport")).toBe(1);
    expect(device.close).not.toHaveBeenCalled();
    hid.disconnect(device);
    await assertion;
    expect(device.sent).toHaveLength(1);
    expectClosed();
  });

  it("does not send another read after a disconnect between transactions", async () => {
    const assertion = expect(
      readDeviceProfile((message) => {
        if (message === "Reading filter 1 of 8, pass 1 of 2.")
          hid.disconnect(device);
      }),
    ).rejects.toThrow(/was disconnected/);
    await assertion;
    expect(device.sent).toHaveLength(1);
    expectClosed();
  });

  it.each(["timeout", "disconnect"] as const)(
    "releases an open that completes after %s",
    async (reason) => {
      const opening = deferred<void>();
      device.open.mockImplementationOnce(async () => {
        await opening.promise;
        device.opened = true;
      });
      const assertion = expect(readDeviceProfile()).rejects.toThrow(
        reason === "timeout" ? /Timed out opening/ : /was disconnected/,
      );
      await tick();
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(2_000);
      else hid.disconnect(device);
      await assertion;
      expect(hid.count("disconnect")).toBe(0);
      expect(device.sendReport).not.toHaveBeenCalled();
      opening.resolve();
      await tick();
      expectClosed();
    },
  );

  it("handles open failure without sending reports", async () => {
    device.open.mockRejectedValueOnce(new Error("Busy"));
    await expect(readDeviceProfile()).rejects.toThrow(
      /Could not open.*Close other EQ tools/,
    );
    expect(device.sendReport).not.toHaveBeenCalled();
    expect(device.close).not.toHaveBeenCalled();
  });

  it.each(["sync", "async"] as const)(
    "cleans up after a %s send failure",
    async (kind) => {
      device.respond = () => {
        if (kind === "sync") throw new Error("Transport failure");
        return Promise.reject(new Error("Transport failure"));
      };
      await expect(readDeviceProfile()).rejects.toThrow(
        /Could not send the read request/,
      );
      expect(device.sent).toHaveLength(1);
      expectClosed();
    },
  );

  it("observes a late send rejection after timeout", async () => {
    const sending = deferred<void>();
    device.respond = () => sending.promise;
    const assertion =
      expect(readDeviceProfile()).rejects.toThrow(/Timed out reading/);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    sending.reject(new Error("Late transport failure"));
    await tick();
    expectClosed();
  });

  it("cleans up if a progress callback throws", async () => {
    await expect(
      readDeviceProfile((message) => {
        if (message.startsWith("Reading filter"))
          throw new Error("Progress failed");
      }),
    ).rejects.toThrow("Progress failed");
    expectClosed();
  });

  it("preserves the read error if closing rejects", async () => {
    device.respond = () => {
      device.emit(firmwareReply("0.3"));
    };
    device.close.mockRejectedValueOnce(new Error("Close failed"));
    await expect(readDeviceProfile()).rejects.toThrow(
      /Only Protocol Micro firmware 0.2/,
    );
    expect(device.close).toHaveBeenCalledTimes(1);
  });

  it("returns the snapshot only after the handle has closed", async () => {
    const closing = deferred<void>();
    device.close.mockImplementationOnce(async () => {
      await closing.promise;
      device.opened = false;
    });
    let settled = false;
    const pending = readDeviceProfile().finally(() => {
      settled = true;
    });
    const assertion = expect(pending).resolves.toMatchObject({ slot: null });
    await tick();
    expect(device.sent).toHaveLength(20);
    expect(device.close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(device.opened).toBe(true);
    expect(device.count("inputreport")).toBe(0);
    expect(hid.count("disconnect")).toBe(0);
    closing.resolve();
    await assertion;
    expectClosed();
  });

  it("does not return a successful snapshot if closing rejects", async () => {
    device.close.mockRejectedValueOnce(new Error("Close failed"));
    await expect(readDeviceProfile()).rejects.toThrow(
      /Could not close Protocol Micro/,
    );
    expect(device.sent).toHaveLength(20);
    expect(device.close).toHaveBeenCalledTimes(1);
  });

  it("does not hang or return a successful snapshot if closing never settles", async () => {
    device.close.mockReturnValueOnce(new Promise(() => {}));
    const assertion = expect(readDeviceProfile()).rejects.toThrow(
      /Could not close Protocol Micro/,
    );
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(device.close).toHaveBeenCalledTimes(1);
    expect(device.count("inputreport")).toBe(0);
    expect(hid.count("disconnect")).toBe(0);
  });

  it("can retry after a failed read without a stale listener or busy guard", async () => {
    device.respond = () => {};
    const assertion =
      expect(readDeviceProfile()).rejects.toThrow(/Timed out reading/);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    device.respond = (packet) => {
      device.emit(replyFor(packet));
    };
    await expect(readDeviceProfile()).resolves.toMatchObject({ slot: null });
    expect(device.close).toHaveBeenCalledTimes(2);
    expect(device.opened).toBe(false);
  });
});

describe("pure source-layout decoding", () => {
  it("decodes exact little-endian frequency, unsigned Q, and signed gain", () => {
    const reply = filterReply(3);
    const view = new DataView(reply.buffer);
    view.setUint16(27, 0x1234, true);
    view.setUint16(29, 193, true);
    view.setInt16(31, -897, true);
    expect(__deviceTest.decodeBand(dataView(reply, 9))).toEqual({
      id: 4,
      type: "peak",
      frequency: 4660,
      q: 193 / 256,
      gain: -897 / 256,
      enabled: true,
    });
  });

  it.each([19, 20001])(
    "preserves raw frequency %i outside the editor range",
    (frequency) => {
      const reply = filterReply();
      new DataView(reply.buffer).setUint16(27, frequency, true);
      expect(__deviceTest.decodeBand(dataView(reply)).frequency).toBe(
        frequency,
      );
    },
  );

  it.each([-128, -21, -5, 0, 1, 127])(
    "decodes signed global gain %i without a headroom offset",
    (gain) => {
      expect(
        __deviceTest.decodeGlobalGain(dataView(globalReply(gain), 7)),
      ).toBe(gain);
    },
  );

  it.each([0, 3, 4, 5, 0xff])(
    "does not treat unsupported filter type %i as peak",
    (type) => {
      const reply = filterReply();
      reply[33] = type;
      expect(() => __deviceTest.decodeBand(dataView(reply))).toThrow(
        /Only peak/,
      );
    },
  );

  it.each([
    [27, 0],
    [27, 0xffff],
    [29, 0],
    [29, 25],
    [29, 2561],
    [31, 2561],
    [31, -2561],
  ])(
    "rejects out-of-range or uninitialized metadata (%i, %i)",
    (offset, value) => {
      const reply = filterReply();
      new DataView(reply.buffer).setInt16(offset, value, true);
      expect(() => __deviceTest.decodeBand(dataView(reply))).toThrow(
        /invalid or unsupported/,
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite decoded fields (%s)",
    (value) => {
      const band = dataView(filterReply());
      vi.spyOn(band, "getInt16").mockReturnValue(value);
      expect(() => __deviceTest.decodeBand(band)).toThrow(
        /invalid or unsupported/,
      );
      const global = dataView(globalReply());
      vi.spyOn(global, "getInt8").mockReturnValue(value);
      expect(() => __deviceTest.decodeGlobalGain(global)).toThrow(
        /global gain is invalid/,
      );
    },
  );

  it("accepts the documented Q and gain bounds without rounding", () => {
    const reply = filterReply();
    const view = new DataView(reply.buffer);
    view.setUint16(29, 26, true);
    view.setInt16(31, -2560, true);
    expect(__deviceTest.decodeBand(view)).toMatchObject({
      q: 26 / 256,
      gain: -10,
    });
    view.setUint16(29, 2560, true);
    view.setInt16(31, 2560, true);
    expect(__deviceTest.decodeBand(view)).toMatchObject({ q: 10, gain: 10 });
  });
});
