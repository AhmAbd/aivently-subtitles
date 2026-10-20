import type { SubtitleFormat } from "./model.js";

export type DetectionStatus = "supported" | "gated" | "mismatch" | "unsupported";

export interface DetectSubtitleInput {
  filename?: string | null;
  mediaType?: string | null;
  content: string;
}

export interface SubtitleDetection {
  format: SubtitleFormat | null;
  status: DetectionStatus;
  declaredFormat: SubtitleFormat | null;
}

const extensionFormats: Record<string, SubtitleFormat> = {
  ass: "ass",
  csv: "csv",
  dfxp: "ttml",
  ebu: "ebu-stl",
  lrc: "lrc",
  mpl2: "mpl2",
  sbv: "sbv",
  sami: "sami",
  sami2: "sami",
  smi: "sami",
  scc: "scc",
  srt: "srt",
  ssa: "ass",
  sub: "sub",
  tmp: "tmp",
  ttml: "ttml",
  txt: "plain",
  vtt: "vtt",
};

function extensionOf(filename: string | null | undefined): string | null {
  const match = filename
    ?.trim()
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/u);
  return match?.[1] ?? null;
}

function declaredFormat(input: DetectSubtitleInput): SubtitleFormat | null {
  const extension = extensionOf(input.filename);
  if (extension && extensionFormats[extension]) return extensionFormats[extension];
  const mediaType = input.mediaType?.toLowerCase().split(";", 1)[0];
  if (mediaType === "text/vtt") return "vtt";
  if (mediaType === "application/x-subrip" || mediaType === "text/srt") return "srt";
  if (mediaType === "text/plain") return "plain";
  return null;
}

function contentFormat(content: string): SubtitleFormat | null {
  const text = content
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .trimStart();
  if (/^WEBVTT(?:\s|$)/u.test(text)) return "vtt";
  if (/^Scenarist_SCC V1\.0(?:\s|$)/u.test(text)) return "scc";
  if (/^\[script info\]/imu.test(text) || /^Dialogue:\s*\d+,/mu.test(text)) return "ass";
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{1,3}\s+-->\s+/mu.test(text)) return "srt";
  if (/^\d{1,2}:\d{2}:\d{2}\.\d{3},\d{1,2}:\d{2}:\d{2}\.\d{3}$/mu.test(text)) return "sbv";
  if (/^\[\d{2}:\d{2}(?:\.\d{2,3})?\]/mu.test(text)) return "lrc";
  if (/^\{\d+\}\{\d+\}/mu.test(text)) return "sub";
  if (/<(?:tt|sami)(?:\s|>)/iu.test(text)) return /<sami(?:\s|>)/iu.test(text) ? "sami" : "ttml";
  if (/^\[\d+\]\[\d+\]/mu.test(text)) return "mpl2";
  if (/^\d{2}:\d{2}:\d{2}:.+/mu.test(text)) return "tmp";
  if (/^\s*Start\s*,\s*End\s*,\s*Text(?:\s*,|\s*$)/imu.test(text)) return "csv";
  if (text.length > 0) return "plain";
  return null;
}

const enabledTextFormats = new Set<SubtitleFormat>([
  "srt",
  "vtt",
  "ass",
  "sbv",
  "lrc",
  "sub",
  "ttml",
  "sami",
  "mpl2",
  "tmp",
  "csv",
]);

export interface BitmapSubtitleCapability {
  format: "vobsub" | "pgs";
  status: "disabled";
  reason: "ocr_quality_gate_required";
  reservesCredits: false;
}

export function detectBitmapSubtitle(input: {
  filename?: string | null;
  bytes?: Uint8Array | null;
}): BitmapSubtitleCapability | null {
  const extension = extensionOf(input.filename);
  const bytes = input.bytes;
  if (
    extension === "sup" ||
    (bytes && bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x47)
  ) {
    return {
      format: "pgs",
      status: "disabled",
      reason: "ocr_quality_gate_required",
      reservesCredits: false,
    };
  }
  if (extension === "idx") {
    return {
      format: "vobsub",
      status: "disabled",
      reason: "ocr_quality_gate_required",
      reservesCredits: false,
    };
  }
  return null;
}

export function detectSubtitleFormat(input: DetectSubtitleInput): SubtitleDetection {
  const extension = extensionOf(input.filename);
  if (extension === "sup" || extension === "idx") {
    return { format: null, status: "unsupported", declaredFormat: null };
  }
  const declared = declaredFormat(input);
  const detected = contentFormat(input.content);
  if (!detected) return { format: null, status: "unsupported", declaredFormat: declared };
  if (declared && declared !== detected && !(declared === "plain" && detected === "plain")) {
    return { format: detected, status: "mismatch", declaredFormat: declared };
  }
  if (detected === "plain") {
    return { format: detected, status: "gated", declaredFormat: declared };
  }
  if (enabledTextFormats.has(detected)) {
    return { format: detected, status: "supported", declaredFormat: declared };
  }
  return { format: detected, status: "gated", declaredFormat: declared };
}
