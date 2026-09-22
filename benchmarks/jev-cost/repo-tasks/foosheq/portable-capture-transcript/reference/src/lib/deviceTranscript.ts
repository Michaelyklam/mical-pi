import {
  VENDOR_ID, PRODUCT_ID, PRODUCT_NAME, REPORT_ID, CAPTURE_REQUESTS,
  readPacket, createCaptureVerifier, type DeviceSnapshot,
} from "./deviceProtocol";

export type CaptureRecord = { reportId: 75; request: number[]; response: number[] };
export type CaptureTranscript = {
  version: 1;
  device: { vendorId: 13058; productId: 49679; productName: "Protocol Micro" };
  readAt: string;
  records: CaptureRecord[];
};
const MAX_BYTES = 32 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bytes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid byte array.");
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !Number.isInteger(value[index]) || value[index] < 0 || value[index] > 255)
      throw new Error("Invalid byte array.");
  }
  return value.slice();
}
function checkSize(text: string): void {
  if (typeof text !== "string" || text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES)
    throw new Error("Capture transcript must be at most 32 KiB of JSON text.");
}
function checked(input: unknown): { transcript: CaptureTranscript; snapshot: DeviceSnapshot } {
  if (!record(input) || input.version !== 1 || !record(input.device) ||
    input.device.vendorId !== VENDOR_ID || input.device.productId !== PRODUCT_ID || input.device.productName !== PRODUCT_NAME ||
    typeof input.readAt !== "string" || !Number.isFinite(Date.parse(input.readAt)) || new Date(input.readAt).toISOString() !== input.readAt ||
    !Array.isArray(input.records) || input.records.length !== CAPTURE_REQUESTS.length)
    throw new Error("Invalid version 1 Protocol Micro transcript.");
  const verifier = createCaptureVerifier();
  const records: CaptureRecord[] = [];
  for (let index = 0; index < CAPTURE_REQUESTS.length; index += 1) {
    const entry = input.records[index];
    if (!record(entry) || entry.reportId !== REPORT_ID) throw new Error("Invalid capture record.");
    const request = bytes(entry.request);
    const response = bytes(entry.response);
    const expected = CAPTURE_REQUESTS[index]!;
    const expectedBytes = Array.from(readPacket(expected));
    if (request.length !== expectedBytes.length || request.some((byte, position) => byte !== expectedBytes[position]))
      throw new Error("Capture requests are outside the ordered read allowlist.");
    const data = Uint8Array.from(response);
    verifier.accept(expected, new DataView(data.buffer));
    records.push({ reportId: REPORT_ID, request, response });
  }
  const device = { vendorId: VENDOR_ID, productId: PRODUCT_ID, productName: PRODUCT_NAME } as const;
  const transcript: CaptureTranscript = { version: 1, device, readAt: input.readAt, records };
  return { transcript, snapshot: verifier.finish(device, input.readAt) };
}
export function verifyCaptureTranscript(transcript: CaptureTranscript): DeviceSnapshot {
  return checked(transcript).snapshot;
}
export function serializeCaptureTranscript(transcript: CaptureTranscript): string {
  const text = JSON.stringify(checked(transcript).transcript);
  checkSize(text);
  return text;
}
export function parseCaptureTranscript(text: string): CaptureTranscript {
  checkSize(text);
  return checked(JSON.parse(text)).transcript;
}
