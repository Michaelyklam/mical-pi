import { expect, vi } from "vitest";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function reply(packet: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(63);
  bytes.set([0x80, packet[1], 0]);
  const view = new DataView(bytes.buffer);
  if (packet[1] === 0x0c) bytes.set([48, 46, 50], 3);
  else if (packet[1] === 0x09) {
    bytes[4] = packet[4];
    view.setUint16(27, 777 + packet[4] * 173, true);
    view.setUint16(29, 193 + packet[4], true);
    view.setInt16(31, -897 + packet[4], true);
    bytes[33] = 2;
    bytes[35] = 101; // unverified padding must never become a slot
  } else if (packet[1] === 0x03) view.setInt8(4, -5);
  else throw Error("Forbidden mock command");
  return bytes;
}
export function offsetView(bytes: Uint8Array) {
  const buffer = new Uint8Array(bytes.length + 21).fill(0xed);
  buffer.set(bytes, 9);
  return new DataView(buffer.buffer, 9, bytes.length);
}
class Tracked extends EventTarget {
  listeners = new Map<string, Set<any>>();
  override addEventListener(type: string, fn: any, options?: any) {
    super.addEventListener(type, fn, options);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  override removeEventListener(type: string, fn: any, options?: any) {
    super.removeEventListener(type, fn, options); this.listeners.get(type)?.delete(fn);
  }
  count(type: string) { return this.listeners.get(type)?.size ?? 0; }
}
export class MockDevice extends Tracked {
  vendorId = 0x3302;
  productId = 0xc20f;
  productName = "Protocol Micro";
  opened = false;
  collections = [{ inputReports: [{ reportId: 75 }], outputReports: [{ reportId: 75 }], children: [] }];
  packets: number[][] = [];
  open = vi.fn(async () => { this.opened = true; });
  close = vi.fn(async () => { this.opened = false; });
  respond: (packet: Uint8Array) => void | Promise<void> = (packet) => this.emit(reply(packet));
  sendReport = vi.fn(async (reportId: number, source: Uint8Array) => {
    expect(reportId).toBe(75);
    const packet = new Uint8Array(source);
    expect(packet[0]).toBe(0x80);
    if (packet[1] === 0x09) expect([...packet]).toEqual([0x80, 9, 0, 0, packet[4], 0]);
    else expect([...packet]).toEqual([0x80, packet[1], 0]);
    expect([3, 9, 12]).toContain(packet[1]);
    expect(this.opened).toBe(true);
    this.packets.push([...packet]);
    await this.respond(packet);
  });
  emit(bytes: Uint8Array | DataView, reportId = 75, device: any = this) {
    this.dispatchEvent(Object.assign(new Event("inputreport"), { reportId, device, data: bytes instanceof DataView ? bytes : offsetView(bytes) }));
  }
}
export class MockHid extends Tracked {
  device = new MockDevice();
  requestDevice = vi.fn(async (_options?: unknown) => [this.device]);
  getDevices = vi.fn(() => { throw Error("Enumeration forbidden"); });
  disconnect(device = this.device) { this.dispatchEvent(Object.assign(new Event("disconnect"), { device })); }
}
export function setupHid() {
  const hid = new MockHid();
  vi.stubGlobal("navigator", { hid });
  return { hid, device: hid.device };
}
export const tick = () => vi.advanceTimersByTimeAsync(0);
export function observe<T>(promise: Promise<T>) {
  const state: { status: string; value?: T; reason?: unknown } = { status: "pending" };
  const done = promise.then(value => { state.status = "resolved"; state.value = value; }, reason => { state.status = "rejected"; state.reason = reason; });
  return { state, done };
}
