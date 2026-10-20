import { describe, expect, it } from "vitest";
import { copySubtitle, renderSubtitleExport } from "../src/export.js";
import {
  createSubtitleDocument,
  type SubtitleDocument,
  type SubtitleFormat,
} from "../src/model.js";

function document(
  format: SubtitleFormat = "srt",
  roundTrip: "preserve" | "fallback" = "preserve",
): SubtitleDocument {
  return createSubtitleDocument({
    id: "doc-export",
    format,
    roundTrip,
    sourceLanguage: "en",
    targetLanguage: "tr",
    metadata:
      format === "vtt"
        ? {
            vttHeader: "WEBVTT - Synthetic",
            vttHeaderLines: ["Kind: captions"],
            vttBlocks: [{ beforeOrdinal: 1, lines: ["NOTE retained"] }],
          }
        : { note: "synthetic" },
    cues: [
      {
        id: "cue-1",
        ordinal: 1,
        startMs: 0,
        endMs: 2_000,
        text: "Hello\nline two",
        speaker: "ALICE",
        style: "Emphasis",
        formatData:
          format === "vtt"
            ? { vttCueIdentifier: "intro", vttSettings: "align:start" }
            : { srtIndex: "10" },
      },
      {
        id: "cue-2",
        ordinal: 2,
        startMs: 2_500,
        endMs: 4_000,
        text: "Bye",
      },
    ],
  });
}

describe("subtitle copy forms", () => {
  it("copies full and selected plain text in canonical order with stable LF", () => {
    const source = document();
    expect(copySubtitle(source, { form: "plain" })).toBe("Hello\nline two\nBye\n");
    expect(copySubtitle(source, { form: "selected", cueIds: ["cue-2", "cue-1"] })).toBe(
      "Hello\nline two\nBye\n",
    );
  });

  it("copies deterministic timestamped text", () => {
    expect(copySubtitle(document(), { form: "timestamped" })).toBe(
      "00:00:00.000 --> 00:00:02.000\nHello\nline two\n\n" + "00:00:02.500 --> 00:00:04.000\nBye\n",
    );
  });

  it("rejects an empty selection and leaks no cue or document metadata", () => {
    const source = document();
    expect(() => copySubtitle(source, { form: "selected", cueIds: [] })).toThrow(
      "subtitle_copy_selection_empty",
    );
    const copied = copySubtitle(source, { form: "plain" });
    expect(copied).not.toContain("cue-1");
    expect(copied).not.toContain("ALICE");
    expect(copied).not.toContain("Emphasis");
    expect(copied).not.toContain("synthetic");
  });
});

describe("subtitle exports", () => {
  it("renders deterministic SRT, WebVTT, ASS, TXT, and JSON with LF endings", () => {
    const source = document();
    const formats = ["srt", "vtt", "ass", "txt", "json"] as const;

    for (const format of formats) {
      const first = renderSubtitleExport(source, { format });
      const second = renderSubtitleExport(source, { format });
      expect(first).toEqual(second);
      expect(first.content).not.toContain("\r");
      expect(first.content!.endsWith("\n")).toBe(true);
    }

    expect(renderSubtitleExport(source, { format: "srt" }).content).toBe(
      "10\n00:00:00,000 --> 00:00:02,000\nHello\nline two\n\n" +
        "2\n00:00:02,500 --> 00:00:04,000\nBye\n",
    );
    expect(renderSubtitleExport(source, { format: "vtt" }).content).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello\nline two\n\n" +
        "00:00:02.500 --> 00:00:04.000\nBye\n",
    );
    expect(renderSubtitleExport(source, { format: "ass" }).content).toContain(
      "Dialogue: 0,0:00:00.00,0:00:02.00,Emphasis,ALICE",
    );
    expect(renderSubtitleExport(source, { format: "ass" }).content).toContain(
      "Style: Emphasis,Arial,20",
    );
    expect(renderSubtitleExport(source, { format: "ass" }).content).toContain("Hello\\Nline two");
    expect(renderSubtitleExport(source, { format: "txt" }).content).toBe("Hello\nline two\nBye\n");
    expect(JSON.parse(renderSubtitleExport(source, { format: "json" }).content!)).toMatchObject({
      version: "v2",
      document: {
        id: "doc-export",
        format: { metadata: {} },
        cues: [
          { id: "cue-1", speaker: "ALICE", style: "Emphasis", text: "Hello\nline two" },
          { id: "cue-2", text: "Bye" },
        ],
      },
    });
  });

  it("blocks ASS control syntax that cannot be represented as authoritative plain text", () => {
    const source = document();
    source.document.cues[0]!.text = "Literal {override} and \\N token";
    source.document.cues[0]!.lineBreaks = [];
    expect(renderSubtitleExport(source, { format: "ass" })).toMatchObject({
      content: null,
      format: "ass",
      warnings: expect.arrayContaining([{ code: "ass_text_unrepresentable", cueIds: [] }]),
    });
  });

  it("blocks invalid timed-text cue boundaries and unsafe speaker templates", () => {
    for (const text of ["", "line\rbreak", "line\n\nbreak", "\nleading", "trailing\n"]) {
      const source = document();
      source.document.cues[0]!.text = text;
      source.document.cues[0]!.lineBreaks =
        text === "line\n\nbreak"
          ? [4, 5]
          : text === "\nleading"
            ? [0]
            : text === "trailing\n"
              ? [8]
              : [];
      for (const format of ["srt", "vtt"] as const) {
        expect(renderSubtitleExport(source, { format })).toMatchObject({
          content: null,
          format,
          warnings: expect.arrayContaining([{ code: "format_text_unrepresentable", cueIds: [] }]),
        });
      }
    }
    expect(() =>
      renderSubtitleExport(document(), {
        format: "srt",
        constraints: { speakerFormat: "{speaker}\r{text}" },
      }),
    ).toThrow("speaker_format_invalid");
  });

  it("preserves WebVTT metadata, blocks, cue identifiers, and settings", () => {
    const output = renderSubtitleExport(document("vtt"), { format: "vtt" }).content;
    expect(output).toContain("WEBVTT - Synthetic\nKind: captions");
    expect(output).toContain("NOTE retained");
    expect(output).toContain("intro\n00:00:00.000 --> 00:00:02.000 align:start\nHello\nline two");
  });

  it("uses proven SRT/WebVTT original output and blocks unproven original formats", () => {
    for (const format of ["srt", "vtt"] as const) {
      const source = document(format);
      delete source.document.cues[0]!.speaker;
      delete source.document.cues[0]!.style;
      if (format === "srt") source.document.format.metadata = {};
      expect(renderSubtitleExport(source, { format: "original" })).toEqual(
        renderSubtitleExport(source, { format }),
      );
    }

    expect(renderSubtitleExport(document("srt"), { format: "original" })).toEqual({
      content: null,
      format: "original",
      fallbackFormats: ["srt", "vtt"],
      warnings: [
        { code: "gap", cueIds: ["cue-1", "cue-2"] },
        { code: "original_format_unsupported", cueIds: [] },
      ],
    });

    expect(renderSubtitleExport(document("ass"), { format: "original" })).toEqual({
      content: null,
      format: "original",
      fallbackFormats: ["srt", "vtt"],
      warnings: [
        { code: "gap", cueIds: ["cue-1", "cue-2"] },
        { code: "original_format_unsupported", cueIds: [] },
      ],
    });
    expect(renderSubtitleExport(document("srt", "fallback"), { format: "original" })).toEqual({
      content: null,
      format: "original",
      fallbackFormats: ["srt", "vtt"],
      warnings: [
        { code: "format_round_trip_fallback", cueIds: [] },
        { code: "gap", cueIds: ["cue-1", "cue-2"] },
        { code: "original_format_unsupported", cueIds: [] },
      ],
    });
  });

  it("reports every configured constraint without changing authoritative text or timing", () => {
    const source = document();
    source.document.cues[0]!.endMs = 0;
    source.document.cues[1]!.startMs = 500;
    source.document.cues[1]!.endMs = 4_000;
    const overlapping = structuredClone(source.document.cues[1]!);
    Object.assign(overlapping, {
      id: "cue-3",
      ordinal: 3,
      startMs: 3_500,
      endMs: 6_000,
      text: "Third",
    });
    source.document.cues.push(overlapping);
    const before = structuredClone(source);
    const constraints = {
      maxCharsPerLine: 4,
      maxLinesPerCue: 1,
      minCueDurationMs: 1_000,
      maxCueDurationMs: 2_000,
      maxReadingSpeed: 0.5,
    };

    const first = renderSubtitleExport(source, { format: "srt", constraints });
    const second = renderSubtitleExport(source, { format: "srt", constraints });
    expect(first).toEqual(second);
    expect(first.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "non_positive_duration",
        "gap",
        "overlap",
        "minimum_duration",
        "maximum_duration",
        "characters_per_line",
        "lines_per_cue",
        "reading_speed",
      ]),
    );
    expect(source).toEqual(before);
  });

  it("applies speaker formatting only to output and never mutates source text or timing", () => {
    const source = document();
    const before = structuredClone(source);
    const output = renderSubtitleExport(source, {
      format: "srt",
      constraints: { speakerFormat: "{speaker}: {text}" },
    });

    expect(output.content).toContain("ALICE: Hello\nline two");
    expect(output.content).toContain("\nBye\n");
    expect(source).toEqual(before);
  });
});
