import { LIMITS, type Band, type Profile } from "./eq";

export type DeviceSnapshot = {
  profile: Profile;
  firmware: string;
  /** null means the active slot is unavailable from the verified read commands. */
  slot: number | null;
  productName: string;
  vendorId: number;
  productId: number;
  readAt: string;
};

export const VENDOR_ID = 0x3302;
export const PRODUCT_ID = 0xc20f;
export const PRODUCT_NAME = "Protocol Micro";
export const REPORT_ID = 0x4b;
export const FILTER_COUNT = 8;
export type ReadRequest =
  { kind: "firmware" } | { kind: "filter"; index: number } | { kind: "global" };

// This is the only packet constructor. No caller can supply arbitrary bytes.
export function readPacket(request: ReadRequest): Uint8Array<ArrayBuffer> {
  switch (request.kind) {
    case "firmware":
      return new Uint8Array([0x80, 0x0c, 0x00]);
    case "global":
      return new Uint8Array([0x80, 0x03, 0x00]);
    case "filter": {
      if (
        !Number.isInteger(request.index) ||
        request.index < 0 ||
        request.index >= FILTER_COUNT
      ) {
        throw new Error("The filter index is not supported.");
      }
      return new Uint8Array([0x80, 0x09, 0x00, 0x00, request.index, 0x00]);
    }
  }
}

function requireLength(data: DataView, length: number): void {
  if (data.byteLength < length) {
    throw new Error(
      "The device returned an incomplete read response. No profile was imported.",
    );
  }
}

export function decodeFirmware(data: DataView): string {
  requireLength(data, 6);
  const firmware = String.fromCharCode(
    data.getUint8(3),
    data.getUint8(4),
    data.getUint8(5),
  );
  // The protocol's firmware field is exactly bytes 3..5, not the whole report.
  // Real firmware 0.2 reuses the remaining report buffer: its tail contains
  // bytes from the preceding filter read. Only the fixed-width version belongs
  // to this response. The caller still requires two matching "0.2" reads.
  return firmware;
}

export function decodeBand(data: DataView): Band {
  requireLength(data, 34);
  const index = data.getUint8(4);
  const frequency = data.getUint16(27, true);
  const q = data.getUint16(29, true) / 256;
  const gain = data.getInt16(31, true) / 256;
  if (data.getUint8(33) !== 2) {
    throw new Error(
      "Only peak filters are supported. No profile was imported.",
    );
  }
  // Keep the exact stored fixed-point values. Do not apply the source's
  // model-specific frequency/Q compensation or any assumed headroom offset.
  // Reject disabled/uninitialized metadata instead of inventing editable values.
  if (
    index >= FILTER_COUNT ||
    ![frequency, q, gain].every(Number.isFinite) ||
    frequency === 0 ||
    frequency === 0xffff ||
    q < 0.1 ||
    q > 10 ||
    gain < -10 ||
    gain > 10
  ) {
    throw new Error(
      "A filter has invalid or unsupported values. No profile was imported.",
    );
  }
  return { id: index + 1, type: "peak", frequency, gain, q, enabled: true };
}

export function decodeGlobalGain(data: DataView): number {
  requireLength(data, 5);
  const gain = data.getInt8(4);
  if (!Number.isFinite(gain))
    throw new Error("The global gain is invalid. No profile was imported.");
  return gain;
}


export const CAPTURE_REQUESTS: readonly ReadRequest[] = Object.freeze(
  Array.from({ length: 2 }, () => [
    { kind: "firmware" } as ReadRequest,
    ...Array.from({ length: FILTER_COUNT }, (_, index): ReadRequest => ({ kind: "filter", index })),
    { kind: "global" } as ReadRequest,
  ]).flat().map((request) => Object.freeze(request)),
);

/** Stateful only within one capture; no browser or transport dependencies. */
export function createCaptureVerifier() {
  let count = 0;
  let firmware: string | undefined;
  let gain: number | undefined;
  const bands: Band[] = [];
  return {
    accept(request: ReadRequest, data: DataView): void {
      const expected = CAPTURE_REQUESTS[count];
      if (!expected || JSON.stringify(readPacket(request)) !== JSON.stringify(readPacket(expected)))
        throw new Error("Capture requests are out of order.");
      if (data.byteLength > 64) throw new Error("Read response exceeds 64 bytes.");
      requireLength(data, 2);
      if (data.getUint8(0) !== 0x80 || data.getUint8(1) !== readPacket(request)[1])
        throw new Error("Read response is not correlated.");
      if (request.kind === "firmware") {
        const value = decodeFirmware(data);
        if (firmware !== undefined && firmware !== value)
          throw new Error("The firmware reads did not match. No profile was imported.");
        if (value !== "0.2") throw new Error("Only Protocol Micro firmware 0.2 is supported. No profile was imported.");
        firmware = value;
      } else if (request.kind === "filter") {
        const value = decodeBand(data);
        if (value.id !== request.index + 1) throw new Error("Read response filter is not correlated.");
        if (bands[request.index] && JSON.stringify(bands[request.index]) !== JSON.stringify(value))
          throw new Error("The filter reads did not match. No profile was imported.");
        bands[request.index] = value;
      } else {
        const value = decodeGlobalGain(data);
        if (gain !== undefined && gain !== value)
          throw new Error("The global gain reads did not match. No profile was imported.");
        gain = value;
      }
      count += 1;
    },
    finish(device: Pick<DeviceSnapshot, "productName" | "vendorId" | "productId">, readAt: string): DeviceSnapshot {
      if (count !== 20 || firmware === undefined || gain === undefined || bands.length !== FILTER_COUNT)
        throw new Error("The device read was incomplete. No profile was imported.");
      if (bands.some((band) => band.frequency < LIMITS.frequencyMin || band.frequency > LIMITS.frequencyMax) || gain < LIMITS.preampMin || gain > LIMITS.preampMax)
        throw new Error(`The device settings exceed the editor ranges. Frequency must be ${LIMITS.frequencyMin}-${LIMITS.frequencyMax} Hz and preamp must be ${LIMITS.preampMin} to ${LIMITS.preampMax} dB. No profile was imported.`);
      return {
        profile: {
          id: "protocol-micro-snapshot", name: "Protocol Micro snapshot",
          description: "Read-only EQ capture from Protocol Micro. The active slot is not available.",
          preamp: gain, bands: bands.map((band) => ({ ...band })),
        },
        firmware, slot: null,
        productName: device.productName, vendorId: device.vendorId, productId: device.productId, readAt,
      };
    },
  };
}
