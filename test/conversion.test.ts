import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertEbuStl,
  convertScc,
  subtitleConversionCapabilities,
  validateSubtitleConversionParity,
} from "../src/convert.js";

const fixtures = join(import.meta.dirname, "fixtures");

interface BinaryImage {
  version: string;
  provenance: string;
  size: number;
  fills: Array<{ start: number; end: number; byte: number }>;
  writes: Array<{ offset: number; ascii?: string; hex?: string }>;
}

function image(name: string): Uint8Array {
  const fixture = JSON.parse(readFileSync(join(fixtures, "ebu-stl", name), "utf8")) as BinaryImage;
  expect(fixture).toMatchObject({
    version: "v1",
    provenance: expect.stringContaining("synthetic"),
  });
  const bytes = new Uint8Array(fixture.size);
  for (const fill of fixture.fills) bytes.fill(fill.byte, fill.start, fill.end);
  for (const write of fixture.writes) {
    const value = write.ascii
      ? new TextEncoder().encode(write.ascii)
      : Uint8Array.from(write.hex!.match(/../gu)!.map((pair) => Number.parseInt(pair, 16)));
    bytes.set(value, write.offset);
  }
  return bytes;
}

describe("SCC and EBU-STL conversion gates", () => {
  it("converts SCC dialogue and preserves declared-frame timing", () => {
    const document = convertScc(readFileSync(join(fixtures, "scc", "valid.scc"), "utf8"), {
      id: "scc-document",
      sourceLanguage: "en",
      frameRate: 30,
    });
    expect(
      document.document.cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    ).toEqual([
      { startMs: 0, endMs: 1500, text: "Hello world" },
      { startMs: 2000, endMs: 3000, text: "Bye" },
    ]);
    expect(
      validateSubtitleConversionParity(document, {
        frameRate: 30,
        cues: [
          { startMs: 0, endMs: 1500, text: "Hello world" },
          { startMs: 2000, endMs: 3000, text: "Bye" },
        ],
      }),
    ).toMatchObject({ exactDialogue: true, exactOrder: true, maximumBoundaryDeltaMs: 0 });
  });

  it("converts EBU-STL blocks, 8A line breaks, and 8F termination", () => {
    const document = convertEbuStl(image("valid.json"), {
      id: "ebu-document",
      sourceLanguage: "en",
    });
    expect(document.document.format.metadata).toMatchObject({
      ebuFrameRate: 25,
      ebuCharacterCodeTable: "00",
    });
    expect(
      document.document.cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    ).toEqual([
      { startMs: 0, endMs: 1240, text: "Hello\nworld" },
      { startMs: 2000, endMs: 3000, text: "Bye" },
    ]);
  });

  it("rejects malformed conversion input and parity beyond one source frame", () => {
    expect(() =>
      convertScc(readFileSync(join(fixtures, "scc", "malformed.scc"), "utf8"), {
        id: "bad-scc",
        frameRate: 30,
      }),
    ).toThrow();
    expect(() => convertEbuStl(image("malformed.json"), { id: "bad-ebu" })).toThrow();
    const document = convertScc(readFileSync(join(fixtures, "scc", "valid.scc"), "utf8"), {
      id: "parity-scc",
      frameRate: 30,
    });
    expect(() =>
      validateSubtitleConversionParity(document, {
        frameRate: 30,
        cues: [
          { startMs: 100, endMs: 1500, text: "Hello world" },
          { startMs: 2000, endMs: 3000, text: "Bye" },
        ],
      }),
    ).toThrow("subtitle_conversion_parity_invalid");
  });

  it("advertises only fixture-proven conversion capabilities", () => {
    expect(subtitleConversionCapabilities()).toEqual({ scc: true, "ebu-stl": true });
  });
});
