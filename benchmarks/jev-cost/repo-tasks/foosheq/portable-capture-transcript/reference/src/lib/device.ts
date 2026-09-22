/// <reference types="w3c-web-hid" />

import { VENDOR_ID, PRODUCT_ID, PRODUCT_NAME, REPORT_ID, FILTER_COUNT, CAPTURE_REQUESTS,
  readPacket, decodeFirmware, decodeBand, decodeGlobalGain, createCaptureVerifier,
  type ReadRequest, type DeviceSnapshot } from "./deviceProtocol";
import type { CaptureTranscript, CaptureRecord } from "./deviceTranscript";
export type { DeviceSnapshot } from "./deviceProtocol";

// Response offsets follow this 0BSD source and are covered by the read-only
// firmware 0.2 hardware captures in fixtures/protocol-micro-0.2.json:
// https://raw.githubusercontent.com/jeromeof/devicePEQ/0617f382e76629792a5933e6933e4b396a756a93/devicePEQ/walkplayHidHandler.js
// IMPORTANT: pullFromDevice explicitly warns that per-filter byte 35 is not a
// reliable slot. getCurrentSlot uses a different, bulk request outside our
// allowlist. A read-only snapshot preserves verified EQ values and uses null
// for the unavailable slot. Never infer a slot from per-filter padding.
const READ = 0x80;
const TIMEOUT_MS = 2_000;
const CLOSE_TIMEOUT_MS = 500;
const UNSUPPORTED_BROWSER =
  "WebHID is not available in this browser. Safari and Firefox cannot read this device. Use desktop Chrome or Edge over HTTPS, or keep using Foosh EQ offline.";
const CANCELLED = "No device selected. You can keep using Foosh EQ offline.";
let reading = false;

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
export async function readDeviceCapture(
  onProgress?: (message: string) => void,
): Promise<{ snapshot: DeviceSnapshot; transcript: CaptureTranscript }> {
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

      const verifier = createCaptureVerifier();
      const records: CaptureRecord[] = [];
      for (let index = 0; index < CAPTURE_REQUESTS.length; index += 1) {
        const request = CAPTURE_REQUESTS[index]!;
        const pass = Math.floor(index / 10) + 1;
        if (request.kind === "firmware") onProgress?.(`Reading firmware and EQ, pass ${pass} of 2.`);
        else if (request.kind === "filter") onProgress?.(`Reading filter ${request.index + 1} of ${FILTER_COUNT}, pass ${pass} of 2.`);
        else onProgress?.(`Reading global gain, pass ${pass} of 2.`);
        const response = await readResponse(device, controller.signal, request, (data) => {
          verifier.accept(request, data);
          return Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        });
        records.push({ reportId: REPORT_ID, request: Array.from(readPacket(request)), response });
      }
      if (controller.signal.aborted) throw abortError(controller.signal);
      const readAt = new Date().toISOString();
      const snapshot = verifier.finish(device, readAt);
      const transcript: CaptureTranscript = {
        version: 1,
        device: { vendorId: VENDOR_ID, productId: PRODUCT_ID, productName: PRODUCT_NAME },
        readAt, records,
      };
      captureVerified = true;
      return { snapshot, transcript };
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

/** Backward-compatible snapshot-only API using the same capture/guard. */
export async function readDeviceProfile(onProgress?: (message: string) => void): Promise<DeviceSnapshot> {
  return (await readDeviceCapture(onProgress)).snapshot;
}
