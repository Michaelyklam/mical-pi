/// <reference types="w3c-web-hid" />

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

// Response offsets follow this 0BSD source and are covered by the read-only
// firmware 0.2 hardware captures in fixtures/protocol-micro-0.2.json:
// https://raw.githubusercontent.com/jeromeof/devicePEQ/0617f382e76629792a5933e6933e4b396a756a93/devicePEQ/walkplayHidHandler.js
// IMPORTANT: pullFromDevice explicitly warns that per-filter byte 35 is not a
// reliable slot. getCurrentSlot uses a different, bulk request outside our
// allowlist. A read-only snapshot preserves verified EQ values and uses null
// for the unavailable slot. Never infer a slot from per-filter padding.
const VENDOR_ID = 0x3302;
const PRODUCT_ID = 0xc20f;
const PRODUCT_NAME = "Protocol Micro";
const REPORT_ID = 0x4b;
const READ = 0x80;
const TIMEOUT_MS = 2_000;
const CLOSE_TIMEOUT_MS = 500;
const FILTER_COUNT = 8;
const UNSUPPORTED_BROWSER =
  "WebHID is not available in this browser. Safari and Firefox cannot read this device. Use desktop Chrome or Edge over HTTPS, or keep using Foosh EQ offline.";
const CANCELLED = "No device selected. You can keep using Foosh EQ offline.";
let reading = false;

type ReadRequest =
  { kind: "firmware" } | { kind: "filter"; index: number } | { kind: "global" };

export function isWebHidSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.hid?.requestDevice === "function"
  );
}

function hasEqReports(collections: readonly HIDCollectionInfo[] = []): boolean {
  return collections.some(
    (collection) =>
      (collection.inputReports?.some(
        (report) => report.reportId === REPORT_ID,
      ) &&
        collection.outputReports?.some(
          (report) => report.reportId === REPORT_ID,
        )) ||
      hasEqReports(collection.children),
  );
}

function selectInterface(devices: HIDDevice[]): HIDDevice {
  if (devices.length === 0) throw new Error(CANCELLED);
  const matches = devices.filter(
    (device) =>
      device.vendorId === VENDOR_ID &&
      device.productId === PRODUCT_ID &&
      device.productName === PRODUCT_NAME,
  );
  if (matches.length === 0) {
    throw new Error(
      "Choose a Protocol Micro with USB ID 3302:C20F. The selected device is not supported.",
    );
  }
  const interfaces = matches.filter((device) =>
    hasEqReports(device.collections),
  );
  if (interfaces.length === 0) {
    throw new Error(
      "The browser did not expose the Protocol Micro EQ interface. Close other EQ tools and try desktop Chrome or Edge.",
    );
  }
  if (interfaces.length !== 1) {
    throw new Error(
      "More than one compatible EQ interface was selected. Select one Protocol Micro and try again.",
    );
  }
  return interfaces[0]!;
}

// This is the only packet constructor. No caller can supply arbitrary bytes.
function readPacket(request: ReadRequest): Uint8Array<ArrayBuffer> {
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

function decodeFirmware(data: DataView): string {
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

function decodeBand(data: DataView): Band {
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

function decodeGlobalGain(data: DataView): number {
  requireLength(data, 5);
  const gain = data.getInt8(4);
  if (!Number.isFinite(gain))
    throw new Error("The global gain is invalid. No profile was imported.");
  return gain;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The device read was stopped.");
}

function withDeadline<T>(
  operation: Promise<T>,
  message: string,
  signal?: AbortSignal,
  timeout = TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(abortError(signal!));
    const timer = setTimeout(() => fail(new Error(message)), timeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Observe the operation even if the signal is already aborted. A late
    // send/open rejection must not become an unhandled rejection.
    operation.then((value) => {
      cleanup();
      resolve(value);
    }, fail);
    if (signal?.aborted) onAbort();
  });
}

async function readResponse<T>(
  device: HIDDevice,
  signal: AbortSignal,
  request: ReadRequest,
  decode: (data: DataView) => T,
): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  const packet = readPacket(request);
  let sent = false;
  let accepted = false;
  let onReport: (event: HIDInputReportEvent) => void;
  const response = new Promise<T>((resolve, reject) => {
    onReport = (event) => {
      if (
        !sent ||
        accepted ||
        event.device !== device ||
        event.reportId !== REPORT_ID
      )
        return;
      const data = event.data;
      if (
        data.byteLength < 2 ||
        data.getUint8(0) !== READ ||
        data.getUint8(1) !== packet[1]
      )
        return;
      if (
        request.kind === "filter" &&
        data.byteLength >= 5 &&
        data.getUint8(4) !== request.index
      )
        return;
      accepted = true;
      try {
        // DataView offsets matter: WebHID data need not cover its whole buffer.
        resolve(decode(data));
      } catch (error) {
        reject(error);
      }
    };
  });
  device.addEventListener("inputreport", onReport!);
  try {
    const sending = Promise.resolve()
      .then(() => {
        if (signal.aborted) throw abortError(signal);
        sent = true;
        return device.sendReport(REPORT_ID, packet);
      })
      .catch(() => {
        if (signal.aborted) throw abortError(signal);
        throw new Error(
          "Could not send the read request. Close other EQ tools and reconnect the device.",
        );
      });
    // Both the send and its correlated response must finish before another read.
    const [value] = await withDeadline(
      Promise.all([response, sending]),
      "Timed out reading Protocol Micro. Reconnect the device and try again.",
      signal,
    );
    return value;
  } finally {
    device.removeEventListener("inputreport", onReport!);
  }
}

async function closeHandle(
  device: HIDDevice,
  requireClosed = false,
): Promise<void> {
  try {
    await withDeadline(
      Promise.resolve().then(() => device.close()),
      "Timed out closing Protocol Micro.",
      undefined,
      CLOSE_TIMEOUT_MS,
    );
  } catch {
    // Never return a successful snapshot if closing failed. On a failed read
    // or late open, preserve the original error without retaining listeners.
    if (requireClosed)
      throw new Error(
        "Could not close Protocol Micro. Disconnect the device before trying again.",
      );
  }
}

/**
 * Call directly from a click handler. The chooser is requested before any await
 * or progress callback. No device is enumerated or retained between calls.
 *
 * Returns the verified EQ readings with slot: null because the allowed replies
 * do not establish the active slot. The handle is closed before returning.
 */
export async function readDeviceProfile(
  onProgress?: (message: string) => void,
): Promise<DeviceSnapshot> {
  if (!isWebHidSupported()) throw new Error(UNSUPPORTED_BROWSER);
  if (reading)
    throw new Error(
      "A device read is already in progress. Wait for it to finish.",
    );
  const hid = navigator.hid;
  reading = true;
  try {
    let devices: HIDDevice[];
    try {
      // Keep this call synchronous under the caller's transient user activation.
      devices = await hid.requestDevice({
        filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
      });
    } catch (error) {
      const name =
        error instanceof Error ||
        (typeof error === "object" && error !== null && "name" in error)
          ? (error as { name: string }).name
          : "";
      if (name === "NotFoundError" || name === "AbortError")
        throw new Error(CANCELLED);
      throw new Error(
        "Device access was not allowed. Use desktop Chrome or Edge over HTTPS and choose the device from the Read device button.",
      );
    }
    const device = selectInterface(devices);
    if (device.opened)
      throw new Error(
        "The EQ interface is already open. Close other EQ tools and try again.",
      );
    const controller = new AbortController();
    const onDisconnect = (event: HIDConnectionEvent) => {
      if (event.device === device) {
        controller.abort(
          new Error(
            "Protocol Micro was disconnected. Reconnect it and try again.",
          ),
        );
      }
    };
    let opened = false;
    let finished = false;
    let captureVerified = false;
    hid.addEventListener("disconnect", onDisconnect);
    try {
      onProgress?.("Opening Protocol Micro for read-only access.");
      const opening = Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw abortError(controller.signal);
          return device.open();
        })
        .catch(() => {
          if (controller.signal.aborted) throw abortError(controller.signal);
          throw new Error(
            "Could not open Protocol Micro. Close other EQ tools or browser tabs and try again.",
          );
        })
        .then(async () => {
          opened = true;
          // If an open finishes after timeout/disconnect, release that late handle.
          if (finished) await closeHandle(device);
        });
      await withDeadline(
        opening,
        "Timed out opening Protocol Micro. Reconnect it and try again.",
        controller.signal,
      );

      let firstFirmware: string | undefined;
      let firstBands: Band[] | undefined;
      let firstGain: number | undefined;
      for (let pass = 0; pass < 2; pass += 1) {
        onProgress?.(`Reading firmware and EQ, pass ${pass + 1} of 2.`);
        const firmware = await readResponse(
          device,
          controller.signal,
          { kind: "firmware" },
          decodeFirmware,
        );
        if (firstFirmware !== undefined && firmware !== firstFirmware) {
          throw new Error(
            "The firmware reads did not match. No profile was imported.",
          );
        }
        if (firmware !== "0.2")
          throw new Error(
            "Only Protocol Micro firmware 0.2 is supported. No profile was imported.",
          );
        firstFirmware = firmware;
        const bands: Band[] = [];
        for (let index = 0; index < FILTER_COUNT; index += 1) {
          onProgress?.(
            `Reading filter ${index + 1} of ${FILTER_COUNT}, pass ${pass + 1} of 2.`,
          );
          const band = await readResponse(
            device,
            controller.signal,
            { kind: "filter", index },
            decodeBand,
          );
          if (
            firstBands &&
            JSON.stringify(band) !== JSON.stringify(firstBands[index])
          ) {
            throw new Error(
              "The filter reads did not match. No profile was imported.",
            );
          }
          bands.push(band);
        }
        onProgress?.(`Reading global gain, pass ${pass + 1} of 2.`);
        const gain = await readResponse(
          device,
          controller.signal,
          { kind: "global" },
          decodeGlobalGain,
        );
        if (firstGain !== undefined && gain !== firstGain) {
          throw new Error(
            "The global gain reads did not match. No profile was imported.",
          );
        }
        firstBands = bands;
        firstGain = gain;
      }
      if (controller.signal.aborted) throw abortError(controller.signal);
      if (
        firstFirmware === undefined ||
        firstBands?.length !== FILTER_COUNT ||
        firstGain === undefined
      ) {
        throw new Error(
          "The device read was incomplete. No profile was imported.",
        );
      }
      // Raw decoding preserves device values. Only complete snapshots must fit
      // the editor model; reject incompatible settings without clamping them.
      if (
        firstBands.some(
          (band) =>
            band.frequency < LIMITS.frequencyMin ||
            band.frequency > LIMITS.frequencyMax,
        ) ||
        firstGain < LIMITS.preampMin ||
        firstGain > LIMITS.preampMax
      ) {
        throw new Error(
          `The device settings exceed the editor ranges. Frequency must be ${LIMITS.frequencyMin}-${LIMITS.frequencyMax} Hz and preamp must be ${LIMITS.preampMin} to ${LIMITS.preampMax} dB. No profile was imported.`,
        );
      }
      captureVerified = true;
      return {
        profile: {
          id: "protocol-micro-snapshot",
          name: "Protocol Micro snapshot",
          description:
            "Read-only EQ capture from Protocol Micro. The active slot is not available.",
          preamp: firstGain,
          bands: firstBands,
        },
        firmware: firstFirmware,
        // Equal padding bytes, including zero or 101, do not establish a slot.
        slot: null,
        productName: device.productName,
        vendorId: device.vendorId,
        productId: device.productId,
        readAt: new Date().toISOString(),
      };
    } finally {
      finished = true;
      hid.removeEventListener("disconnect", onDisconnect);
      if (opened) await closeHandle(device, captureVerified);
    }
  } finally {
    reading = false;
  }
}

// Pure decoders for synthetic and captured-data tests. No packet sender is exposed.
export const __deviceTest = Object.freeze({
  decodeFirmware,
  decodeBand,
  decodeGlobalGain,
});
