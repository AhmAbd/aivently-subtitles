import { describe, expect, it } from "vitest";
import {
  checkSubtitle,
  convertSubtitle,
  dualSubtitles,
  loadSubtitleText,
  mergeSubtitles,
  outputFileName,
  shiftSubtitle,
  subtitleToText,
  SubtitleToolFailure,
  SUBTITLE_TOOL_MAX_BYTES,
} from "../src/tools.js";

const english = `1
00:00:01,000 --> 00:00:03,000
Hello there.

2
00:00:04,000 --> 00:00:06,500
How are you
doing today?
`;

const spanish = `1
00:00:01,100 --> 00:00:02,900
Hola.

2
00:00:04,200 --> 00:00:06,000
¿Cómo estás hoy?
`;

function failure(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof SubtitleToolFailure ? error.code : "other";
  }
  return undefined;
}

describe("loadSubtitleText", () => {
  it("detects and parses SRT", () => {
    const loaded = loadSubtitleText(english, "episode.srt");
    expect(loaded.format).toBe("srt");
    expect(loaded.document.document.cues).toHaveLength(2);
  });

  it("strips a byte-order mark", () => {
    expect(loadSubtitleText(`\uFEFF${english}`, "a.srt").document.document.cues).toHaveLength(2);
  });

  it("rejects empty, unsupported and oversized input", () => {
    expect(failure(() => loadSubtitleText("   ", "a.srt"))).toBe("file_empty");
    expect(failure(() => loadSubtitleText("just some words", "a.txt"))).toBe("format_unsupported");
    expect(failure(() => loadSubtitleText("x".repeat(SUBTITLE_TOOL_MAX_BYTES + 1)))).toBe(
      "file_too_large",
    );
  });
});

describe("convertSubtitle", () => {
  const document = loadSubtitleText(english, "a.srt").document;

  it("writes VTT", () => {
    const vtt = convertSubtitle(document, "vtt");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:03.000");
  });

  it("writes ASS and plain text", () => {
    expect(convertSubtitle(document, "ass")).toContain("Dialogue:");
    expect(convertSubtitle(document, "txt")).toBe("Hello there.\nHow are you\ndoing today?\n");
  });

  it("round-trips VTT back to SRT", () => {
    const vtt = loadSubtitleText(convertSubtitle(document, "vtt"), "a.vtt");
    expect(convertSubtitle(vtt.document, "srt")).toContain("00:00:04,000 --> 00:00:06,500");
  });
});

describe("subtitleToText", () => {
  const document = loadSubtitleText(english, "a.srt").document;

  it("adds timestamps", () => {
    expect(subtitleToText(document, { timestamps: true, joinLines: true })).toBe(
      "[00:00:01] Hello there.\n[00:00:04] How are you doing today?\n",
    );
  });

  it("joins everything into one paragraph", () => {
    expect(subtitleToText(document, { timestamps: false, joinLines: true })).toBe(
      "Hello there. How are you doing today?\n",
    );
  });
});

describe("shiftSubtitle", () => {
  const document = loadSubtitleText(english, "a.srt").document;

  it("moves cues later", () => {
    const shifted = shiftSubtitle(document, { offsetMs: 1500 });
    expect(shifted.document.cues.map((cue) => cue.startMs)).toEqual([2500, 5500]);
  });

  it("clips at zero and drops cues that end before zero", () => {
    const shifted = shiftSubtitle(document, { offsetMs: -3500 });
    expect(shifted.document.cues).toHaveLength(1);
    expect(shifted.document.cues[0]).toMatchObject({ ordinal: 1, startMs: 500, endMs: 3000 });
    const clipped = shiftSubtitle(document, { offsetMs: -2000 });
    expect(clipped.document.cues[0]).toMatchObject({ startMs: 0, endMs: 1000 });
  });

  it("converts 23.976 fps timing to 25 fps", () => {
    const shifted = shiftSubtitle(document, { offsetMs: 0, fromFps: 23.976, toFps: 25 });
    expect(shifted.document.cues[1]!.startMs).toBe(Math.round(4000 * (23.976 / 25)));
  });
});

describe("checkSubtitle", () => {
  it("passes a clean file", () => {
    const report = checkSubtitle(loadSubtitleText(english, "a.srt").document);
    expect(report.cueCount).toBe(2);
    expect(report.durationMs).toBe(6500);
    expect(report.findings).toEqual([]);
  });

  it("flags long lines, extra lines, fast reading and overlaps", () => {
    const bad = `1
00:00:01,000 --> 00:00:02,000
This line is definitely much longer than forty-two characters.

2
00:00:01,500 --> 00:00:04,000
one
two
three
`;
    const report = checkSubtitle(loadSubtitleText(bad, "bad.srt").document);
    expect(report.counts).toMatchObject({
      characters_per_line: 1,
      lines_per_cue: 1,
      reading_speed: 1,
      overlap: 1,
    });
    expect(report.findings.find((finding) => finding.code === "overlap")?.ordinals).toEqual([1, 2]);
  });
});

describe("mergeSubtitles", () => {
  const first = loadSubtitleText(english, "a.srt").document;
  const second = loadSubtitleText(spanish, "b.srt").document;

  it("appends the second file after the first", () => {
    const merged = mergeSubtitles(first, second, { mode: "append", gapMs: 500 });
    expect(merged.document.cues.map((cue) => cue.startMs)).toEqual([1000, 4000, 8100, 11200]);
    expect(merged.document.cues.map((cue) => cue.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it("combines both files by time", () => {
    const merged = mergeSubtitles(first, second, { mode: "combine" });
    expect(merged.document.cues.map((cue) => cue.text)).toEqual([
      "Hello there.",
      "Hola.",
      "How are you\ndoing today?",
      "¿Cómo estás hoy?",
    ]);
  });
});

describe("dualSubtitles", () => {
  it("adds the overlapping translation as a second line", () => {
    const output = dualSubtitles(
      loadSubtitleText(english, "a.srt").document,
      loadSubtitleText(spanish, "b.srt").document,
    );
    expect(output).toContain("00:00:01,000 --> 00:00:03,000\nHello there.\nHola.");
    expect(output).toContain("How are you\ndoing today?\n¿Cómo estás hoy?");
  });

  it("keeps primary cues without a match", () => {
    const lone = `1
00:00:10,000 --> 00:00:11,000
Nadie.
`;
    const output = dualSubtitles(
      loadSubtitleText(english, "a.srt").document,
      loadSubtitleText(lone, "b.srt").document,
    );
    expect(output).toContain("00:00:01,000 --> 00:00:03,000\nHello there.\n\n");
    expect(output).not.toContain("Nadie.");
  });
});

describe("outputFileName", () => {
  it("swaps the extension and adds a suffix", () => {
    expect(outputFileName("C:\\films\\ep01.en.srt", "", "vtt")).toBe("ep01.en.vtt");
    expect(outputFileName("ep01.srt", "synced", "srt")).toBe("ep01.synced.srt");
    expect(outputFileName("", "dual", "srt")).toBe("subtitles.dual.srt");
  });
});
