import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSubtitleFormat } from "../src/detect.js";
import {
  canPreserveOriginal,
  exportSubtitle,
  renderSubtitleExport,
} from "../src/export.js";
import type { SubtitleFormat } from "../src/model.js";
import { parseSubtitle, subtitleInputCapabilities } from "../src/parse.js";

const fixtures = join(import.meta.dirname, "fixtures");
const fixture = (path: string) => readFileSync(join(fixtures, path), "utf8");
const srt = `\uFEFF${fixture("srt/valid.srt").replaceAll("\n", "\r\n")}`;
const vtt = fixture("vtt/valid.vtt");
const shortVtt = "WEBVTT\n\n00:01.000 --> 00:02.500\nShort clock\n";
const launchFixture = JSON.parse(fixture("launch-text-formats.json")) as {
  version: string;
  provenance: string;
  formats: Record<string, { valid: string; malformed: string }>;
};
const launchExtensions: Record<string, string> = {
  ass: "ass",
  sbv: "sbv",
  lrc: "lrc",
  sub: "sub",
  ttml: "ttml",
  sami: "smi",
  mpl2: "mpl2",
  tmp: "tmp",
  csv: "csv",
  plain: "txt",
};
const launchFormats = Object.keys(launchExtensions) as SubtitleFormat[];

describe("SRT and WebVTT parsing", () => {
  it("normalizes BOM, line endings, multiline text, and stable cue IDs", () => {
    const document = parseSubtitle(srt, { id: "doc-srt", format: "srt" });
    expect(document.document.cues).toMatchObject([
      { id: "cue-10", ordinal: 1, startMs: 0, endMs: 1250, text: "Hello\nworld" },
      { id: "cue-20", ordinal: 2, startMs: 2000, endMs: 3000, text: "Bye" },
    ]);
    expect(exportSubtitle(document, "srt")).toBe(fixture("srt/expected.srt"));
    expect(canPreserveOriginal(document)).toBe(true);
  });

  it("preserves WebVTT header metadata, blocks, cue identifiers, and settings", () => {
    const document = parseSubtitle(vtt, { id: "doc-vtt", format: "vtt" });
    expect(document.document.cues[0]?.text).toBe("Hello\nworld");
    expect(exportSubtitle(document, "vtt")).toContain(
      "cue-a\n00:00:00.000 --> 00:00:01.250 align:start position:10%\nHello\nworld",
    );
    expect(exportSubtitle(document, "vtt")).toBe(fixture("vtt/expected.vtt"));
    expect(exportSubtitle(document, "srt")).toBe(
      "1\n00:00:00,000 --> 00:00:01,250\nHello\nworld\n\n2\n00:00:02,000 --> 00:00:03,000\nBye\n",
    );
  });

  it("accepts the short WebVTT minute-second clock", () => {
    const document = parseSubtitle(shortVtt, { id: "doc-short-vtt", format: "vtt" });
    expect(document.document.cues[0]).toMatchObject({ startMs: 1000, endMs: 2500 });
  });

  it("rejects malformed or non-positive cues", () => {
    expect(() =>
      parseSubtitle(fixture("srt/malformed.srt"), {
        id: "bad",
        format: "srt",
      }),
    ).toThrow("subtitle_timing_invalid");
    expect(() =>
      parseSubtitle(fixture("vtt/malformed.vtt"), { id: "bad-vtt", format: "vtt" }),
    ).toThrow("subtitle_timing_invalid");
  });

  it("keeps a versioned synthetic provenance manifest", () => {
    expect(JSON.parse(fixture("manifest.json"))).toMatchObject({
      version: "v1",
      provenance: "synthetic",
      formats: { srt: { expectedCueIds: ["cue-10", "cue-20"] }, vtt: {} },
    });
  });
});

describe("remaining launch text subtitle input gates", () => {
  it("uses versioned synthetic valid and malformed fixtures", () => {
    expect(launchFixture).toMatchObject({ version: "v1", provenance: "synthetic" });
    expect(Object.keys(launchFixture.formats).sort()).toEqual([...launchFormats].sort());
  });

  it("preserves representable ASS style/event metadata and makes overrides an explicit fallback", () => {
    const styled = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Fancy,Arial,24

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 2,0:00:00.00,0:00:01.25,Fancy,ALICE,0010,0020,0030,Banner,Hello
`;
    const document = parseSubtitle(styled, { id: "styled-ass", format: "ass" });
    expect(document.document.format.metadata).toMatchObject({
      assKind: "ass",
      assScriptInfoLines: ["ScriptType: v4.00+", "PlayResX: 1920"],
      assStyleSection: "V4+ Styles",
      assStyleLines: ["Format: Name, Fontname, Fontsize", "Style: Fancy,Arial,24"],
    });
    expect(document.document.cues[0]?.formatData.assEventFields).toMatchObject({
      layer: "2",
      marginl: "0010",
      effect: "Banner",
    });
    expect(canPreserveOriginal(document)).toBe(true);
    expect(renderSubtitleExport(document, { format: "original" }).content).toContain(
      "Dialogue: 2,0:00:00.00,0:00:01.25,Fancy,ALICE,0010,0020,0030,Banner,Hello",
    );

    const overridden = parseSubtitle(styled.replace("Hello", "{\\i1}Hello{\\i0}"), {
      id: "styled-ass-overrides",
      format: "ass",
    });
    expect(overridden.document.format.roundTrip).toBe("fallback");
    expect(overridden.document.cues[0]?.formatData.assOverrides).toEqual([
      { offset: 0, value: "{\\i1}" },
      { offset: 5, value: "{\\i0}" },
    ]);
    expect(canPreserveOriginal(overridden)).toBe(false);
    expect(renderSubtitleExport(overridden, { format: "original" })).toMatchObject({
      content: null,
      fallbackFormats: ["srt", "vtt"],
    });
  });

  for (const format of launchFormats) {
    it(`parses, exports, and semantically round-trips ${format}`, () => {
      const source = launchFixture.formats[format]!;
      const options = {
        id: `doc-${format}`,
        format,
        ...(format === "plain" ? { allowPlainText: true } : {}),
      } as const;
      const first = parseSubtitle(source.valid, options);
      expect(
        first.document.cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ startMs: 0, text: expect.stringContaining("Hello") }),
        ]),
      );
      expect(canPreserveOriginal(first)).toBe(true);
      const rendered = renderSubtitleExport(first, { format: "original" });
      expect(rendered.content).toBeTruthy();
      const second = parseSubtitle(rendered.content!, { ...options, id: `roundtrip-${format}` });
      expect(
        second.document.cues.map(({ startMs, endMs, text, speaker, style }) => ({
          startMs,
          endMs,
          text,
          speaker: speaker ?? null,
          style: style ?? null,
        })),
      ).toEqual(
        first.document.cues.map(({ startMs, endMs, text, speaker, style }) => ({
          startMs,
          endMs,
          text,
          speaker: speaker ?? null,
          style: style ?? null,
        })),
      );
      expect(() => parseSubtitle(source.malformed, options)).toThrow();
    });
  }

  it("detects enabled formats, rejects mismatches, and keeps plain gated", () => {
    for (const format of launchFormats.filter((candidate) => candidate !== "plain")) {
      const valid = launchFixture.formats[format]!.valid;
      expect(
        detectSubtitleFormat({ filename: `captions.${launchExtensions[format]}`, content: valid }),
      ).toMatchObject({ format, status: "supported", declaredFormat: format });
      expect(detectSubtitleFormat({ filename: "captions.srt", content: valid }).status).toBe(
        "mismatch",
      );
    }
    expect(
      detectSubtitleFormat({
        filename: "captions.txt",
        content: launchFixture.formats.plain!.valid,
      }),
    ).toMatchObject({ format: "plain", status: "gated" });
    expect(() =>
      parseSubtitle(launchFixture.formats.plain!.valid, {
        id: "plain-disabled",
        format: "plain",
      }),
    ).toThrow("plain_text_disabled");
  });

  it("advertises input separately from output and keeps pasted text disabled", () => {
    expect(subtitleInputCapabilities()).toMatchObject({
      ass: true,
      sbv: true,
      lrc: true,
      sub: true,
      ttml: true,
      sami: true,
      mpl2: true,
      tmp: true,
      csv: true,
      plain: false,
    });
  });
});
