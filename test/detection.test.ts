import { describe, expect, it } from "vitest";
import { detectBitmapSubtitle, detectSubtitleFormat } from "../src/detect.js";

const srt = "1\n00:00:00,000 --> 00:00:01,000\nHello\n";

describe("subtitle format detection", () => {
  it("accepts matching SRT content and declaration", () => {
    expect(
      detectSubtitleFormat({
        filename: "captions.srt",
        mediaType: "application/x-subrip",
        content: srt,
      }),
    ).toMatchObject({ format: "srt", status: "supported" });
  });

  it("rejects extension/content mismatches", () => {
    expect(
      detectSubtitleFormat({
        filename: "captions.vtt",
        mediaType: "text/vtt",
        content: srt,
      }),
    ).toMatchObject({ status: "mismatch" });
  });

  it("uses a declared media type when the filename is absent", () => {
    expect(
      detectSubtitleFormat({
        mediaType: "text/vtt",
        content: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
      }),
    ).toMatchObject({ format: "vtt", status: "supported" });
  });

  it("rejects empty unknown input", () => {
    expect(detectSubtitleFormat({ content: "" })).toMatchObject({
      format: null,
      status: "unsupported",
    });
  });

  it("does not enable bitmap subtitle formats", () => {
    expect(
      detectSubtitleFormat({
        filename: "captions.sup",
        mediaType: "application/octet-stream",
        content: "PGS",
      }),
    ).toMatchObject({ status: "unsupported" });
    expect(detectBitmapSubtitle({ filename: "captions.sup" })).toEqual({
      format: "pgs",
      status: "disabled",
      reason: "ocr_quality_gate_required",
      reservesCredits: false,
    });
    expect(detectBitmapSubtitle({ filename: "captions.idx" })).toEqual({
      format: "vobsub",
      status: "disabled",
      reason: "ocr_quality_gate_required",
      reservesCredits: false,
    });
  });
});
