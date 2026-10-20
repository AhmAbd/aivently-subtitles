import { describe, expect, it } from "vitest";
import { parseSubtitle } from "../src/parse.js";

function parse(content: string, format: "ass" | "lrc" | "plain" | "ttml") {
  return parseSubtitle(content, {
    id: `parser-limit-${format}`,
    format,
    ...(format === "plain" ? { allowPlainText: true } : {}),
  });
}

describe("subtitle parser complexity limits", () => {
  it("rejects repeated unterminated ASS override prefixes before regex retry work", () => {
    const content = [
      "[Script Info]",
      "ScriptType: v4.00+",
      "",
      "[Events]",
      "Format: Start, End, Text",
      `Dialogue: 0:00:00.00,0:00:01.00,${"{\\".repeat(512)}`,
    ].join("\n");

    expect(() => parse(content, "ass")).toThrow("subtitle_complexity_limit");
  });

  it("rejects repeated unclosed TTML paragraph openings before whole-suffix retry work", () => {
    const content = `<tt>${'<p begin="0s" dur="1s">'.repeat(512)}</tt>`;

    expect(() => parse(content, "ttml")).toThrow("subtitle_complexity_limit");
  });

  it("rejects LRC timestamp expansion before retaining every timestamp match", () => {
    const content = `${"[00:00]".repeat(257)}bounded lyric`;

    expect(() => parse(content, "lrc")).toThrow("subtitle_complexity_limit");
  });

  it("bounds ASS field and metadata arrays and TTML markup tags", () => {
    const assFields = [
      "Start",
      "End",
      ...Array.from({ length: 62 }, (_, index) => `Field${index}`),
      "Text",
    ];
    const assMetadata = [
      "[Script Info]",
      ...Array.from({ length: 1_025 }, () => "Title: bounded"),
    ].join("\n");
    const ttml = `<tt><p begin="0s" dur="1s">${"<i>x</i>".repeat(513)}</p></tt>`;

    expect(() => parse(`[Events]\nFormat: ${assFields.join(",")}`, "ass")).toThrow(
      "subtitle_complexity_limit",
    );
    expect(() => parse(assMetadata, "ass")).toThrow("subtitle_complexity_limit");
    expect(() => parse(ttml, "ttml")).toThrow("subtitle_complexity_limit");
  });

  it("shares cue and cue-text limits across enabled parser formats", () => {
    expect(() => parse("cue\n".repeat(10_001), "plain")).toThrow("subtitle_complexity_limit");
    expect(() => parse("x".repeat(64 * 1024 + 1), "plain")).toThrow("subtitle_complexity_limit");
    expect(() => parse("cue\n".repeat(50_001), "plain")).toThrow("subtitle_complexity_limit");
  });

  it("preserves valid ASS override, TTML markup, and LRC timing semantics", () => {
    const ass = parse(
      [
        "[Script Info]",
        "ScriptType: v4.00+",
        "",
        "[Events]",
        "Format: Start, End, Text",
        "Dialogue: 0:00:00.00,0:00:01.00,{\\i1}Hello{\\i0}",
      ].join("\n"),
      "ass",
    );
    const ttml = parse(
      '<tt><body><p begin="0s" end="1.5s" style="em">Hello<br/>world</p></body></tt>',
      "ttml",
    );
    const lrc = parse("[00:00]Hello\n[00:02]World", "lrc");

    expect(ass.document.cues[0]).toMatchObject({
      text: "Hello",
      formatData: {
        assOverrides: [
          { offset: 0, value: "{\\i1}" },
          { offset: 5, value: "{\\i0}" },
        ],
      },
    });
    expect(ttml.document.cues[0]).toMatchObject({
      startMs: 0,
      endMs: 1500,
      text: "Hello\nworld",
      style: "em",
    });
    expect(lrc.document.cues).toMatchObject([
      { startMs: 0, endMs: 2000, text: "Hello" },
      { startMs: 2000, endMs: 4000, text: "World" },
    ]);
  });
});
