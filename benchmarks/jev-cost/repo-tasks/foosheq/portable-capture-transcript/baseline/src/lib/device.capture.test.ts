import { describe, expect, it } from "vitest";
import { __deviceTest } from "./device";
import capture from "./fixtures/protocol-micro-0.2.json";

// These tests replay saved bytes. They never request or open a hardware device.
function capturedView(hex: string): DataView {
  const bytes = Uint8Array.from(hex.split(" "), (value) => parseInt(value, 16));
  return new DataView(bytes.buffer);
}

describe("captured Protocol Micro firmware 0.2", () => {
  it.each([
    ["after the last filter", capture.firmwareResponseHex, 7],
    ["after the first filter", capture.firmwareAfterFirstFilterHex, 0],
  ] as const)(
    "accepts the actual firmware response %s with reused report bytes",
    (_, hex, filterIndex) => {
      const report = capturedView(hex);
      expect(report.byteLength).toBe(capture.payloadBytes);
      expect(__deviceTest.decodeFirmware(report)).toBe(capture.firmware);
      expect(hex.split(" ").slice(6)).toEqual(
        capture.filterResponseHex[filterIndex]!.split(" ").slice(6),
      );
    },
  );

  it.each(
    capture.expectedFrequencies.map((frequency, index) => ({
      frequency,
      index,
    })),
  )(
    "decodes captured filter $index at $frequency Hz without compensation",
    ({ frequency, index }) => {
      const report = capturedView(capture.filterResponseHex[index]!);
      expect(report.byteLength).toBe(capture.payloadBytes);
      expect(__deviceTest.decodeBand(report)).toEqual({
        id: index + 1,
        type: "peak",
        frequency,
        gain: capture.expectedBandGain,
        q: capture.expectedQ,
        enabled: true,
      });
    },
  );

  it("decodes the captured global gain without treating the tail as metadata", () => {
    const report = capturedView(capture.globalGainResponseHex);
    expect(report.byteLength).toBe(capture.payloadBytes);
    expect(__deviceTest.decodeGlobalGain(report)).toBe(
      capture.expectedGlobalGain,
    );
  });
});
