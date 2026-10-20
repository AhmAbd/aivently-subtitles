import {
  calculateDocumentWarnings,
  createSubtitleDocument,
  detectSubtitleFormat,
  parseSubtitle,
  renderSubtitleExport,
  type SubtitleCue,
  type SubtitleCueInput,
  type SubtitleDocument,
  type SubtitleFormat,
  type WarningConstraints,
} from "./index.js";

/* High-level helpers: load, convert, shift, check, merge and build dual-language
   subtitles. They run anywhere JavaScript runs, including the browser. */

export const SUBTITLE_TOOL_MAX_BYTES = 5 * 1024 * 1024;

export type ToolOutputFormat = "srt" | "vtt" | "ass" | "txt" | "json";

export type SubtitleToolError =
  | "file_too_large"
  | "file_empty"
  | "format_unsupported"
  | "file_invalid"
  | "output_unrepresentable";

export class SubtitleToolFailure extends Error {
  constructor(readonly code: SubtitleToolError) {
    super(code);
  }
}

export interface LoadedSubtitle {
  readonly name: string;
  readonly format: SubtitleFormat;
  readonly document: SubtitleDocument;
}

function baseName(filename: string): string {
  const trimmed = filename.replace(/^.*[\\/]/u, "").replace(/\.[^.]+$/u, "");
  return trimmed || "subtitles";
}

export function outputFileName(
  inputName: string,
  suffix: string,
  format: ToolOutputFormat,
): string {
  const name = baseName(inputName);
  return `${suffix ? `${name}.${suffix}` : name}.${format}`;
}

export function loadSubtitleText(content: string, filename = "subtitles.srt"): LoadedSubtitle {
  if (new TextEncoder().encode(content).byteLength > SUBTITLE_TOOL_MAX_BYTES) {
    throw new SubtitleToolFailure("file_too_large");
  }
  const text = content.replace(/^﻿/u, "");
  if (!text.trim()) throw new SubtitleToolFailure("file_empty");
  const detection = detectSubtitleFormat({ filename, content: text });
  if (!detection.format || detection.status === "unsupported" || detection.format === "plain") {
    throw new SubtitleToolFailure("format_unsupported");
  }
  try {
    const document = parseSubtitle(text, {
      id: "tool-input",
      format: detection.format,
      declaredExtension: filename.split(".").pop() ?? null,
    });
    return { name: filename, format: detection.format, document };
  } catch (error) {
    if (error instanceof SubtitleToolFailure) throw error;
    throw new SubtitleToolFailure("file_invalid");
  }
}

export async function loadSubtitleFile(file: File): Promise<LoadedSubtitle> {
  if (file.size > SUBTITLE_TOOL_MAX_BYTES) throw new SubtitleToolFailure("file_too_large");
  if (file.size === 0) throw new SubtitleToolFailure("file_empty");
  return loadSubtitleText(await file.text(), file.name);
}

function cueInputs(cues: readonly SubtitleCue[]): SubtitleCueInput[] {
  return cues.map((cue, index) => {
    const formatData = { ...cue.formatData };
    delete formatData["srtIndex"];
    delete formatData["vttCueIdentifier"];
    return {
      id: `cue-${index + 1}`,
      ordinal: index + 1,
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cue.text,
      ...(cue.speaker === undefined ? {} : { speaker: cue.speaker }),
      ...(cue.style === undefined ? {} : { style: cue.style }),
      formatData,
    };
  });
}

/** Rebuilds a document after cues changed; numbering and VTT block layout
 * are regenerated rather than preserved. */
function rebuild(document: SubtitleDocument, cues: readonly SubtitleCue[]): SubtitleDocument {
  const metadata = { ...document.document.format.metadata };
  delete metadata["vttBlocks"];
  return createSubtitleDocument({
    id: document.document.id,
    format: document.document.format.detected,
    roundTrip: "fallback",
    metadata,
    cues: cueInputs(cues),
  });
}

function sorted(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return [...cues].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

export function convertSubtitle(document: SubtitleDocument, format: ToolOutputFormat): string {
  const result = renderSubtitleExport(document, { format });
  if (result.content === null) throw new SubtitleToolFailure("output_unrepresentable");
  return result.content;
}

/** The output format a timing tool should keep: the input's own format when
 * it can be written back, otherwise SRT. */
export function preferredTimedFormat(format: SubtitleFormat): "srt" | "vtt" | "ass" {
  return format === "vtt" || format === "ass" ? format : "srt";
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function subtitleToText(
  document: SubtitleDocument,
  options: { timestamps: boolean; joinLines: boolean },
): string {
  const lines = document.document.cues.map((cue) => {
    const text = options.joinLines ? cue.text.replace(/\s*\n\s*/gu, " ") : cue.text;
    return options.timestamps ? `[${clock(cue.startMs)}] ${text}` : text;
  });
  return `${lines.join(options.joinLines && !options.timestamps ? " " : "\n")}\n`;
}

export const FRAME_RATES = [23.976, 24, 25, 29.97, 30] as const;

/** Moves every cue by `offsetMs`, optionally rescaling for a frame-rate
 * change first. Cues pushed entirely before zero are removed; a cue that
 * straddles zero is clipped to start at zero. */
export function shiftSubtitle(
  document: SubtitleDocument,
  options: { offsetMs: number; fromFps?: number; toFps?: number },
): SubtitleDocument {
  const factor =
    options.fromFps && options.toFps && options.fromFps > 0 && options.toFps > 0
      ? options.fromFps / options.toFps
      : 1;
  const cues = document.document.cues
    .map((cue) => ({
      ...cue,
      startMs: Math.round(cue.startMs * factor) + options.offsetMs,
      endMs: Math.round(cue.endMs * factor) + options.offsetMs,
    }))
    .filter((cue) => cue.endMs > 0)
    .map((cue) => ({ ...cue, startMs: Math.max(0, cue.startMs) }))
    .filter((cue) => cue.endMs > cue.startMs);
  return rebuild(document, cues);
}

export const DEFAULT_CHECK_RULES: Required<WarningConstraints> = {
  maxCharsPerLine: 42,
  maxLinesPerCue: 2,
  maxReadingSpeed: 17,
  minCueDurationMs: 833,
  maxCueDurationMs: 7000,
};

export type CheckCode =
  | "characters_per_line"
  | "lines_per_cue"
  | "reading_speed"
  | "minimum_duration"
  | "maximum_duration"
  | "overlap"
  | "non_positive_duration";

export interface CheckFinding {
  readonly code: CheckCode;
  readonly ordinals: readonly number[];
}

export interface CheckReport {
  readonly cueCount: number;
  readonly durationMs: number;
  readonly findings: readonly CheckFinding[];
  readonly counts: Readonly<Partial<Record<CheckCode, number>>>;
}

const REPORTED: ReadonlySet<string> = new Set<CheckCode>([
  "characters_per_line",
  "lines_per_cue",
  "reading_speed",
  "minimum_duration",
  "maximum_duration",
  "overlap",
  "non_positive_duration",
]);

export function checkSubtitle(
  document: SubtitleDocument,
  rules: WarningConstraints = DEFAULT_CHECK_RULES,
): CheckReport {
  const cues = document.document.cues;
  const ordinalById = new Map(cues.map((cue) => [cue.id, cue.ordinal]));
  const findings = calculateDocumentWarnings(document, rules)
    .filter((warning) => REPORTED.has(warning.code))
    .map((warning) => ({
      code: warning.code as CheckCode,
      ordinals: warning.cueIds.map((id) => ordinalById.get(id) ?? 0),
    }));
  const counts: Partial<Record<CheckCode, number>> = {};
  for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  const durationMs = cues.reduce((latest, cue) => Math.max(latest, cue.endMs), 0);
  return { cueCount: cues.length, durationMs, findings, counts };
}

/** `append` places the second file after the first, `gapMs` after its last
 * cue ends. `combine` interleaves both files by start time. */
export function mergeSubtitles(
  first: SubtitleDocument,
  second: SubtitleDocument,
  options: { mode: "append" | "combine"; gapMs?: number },
): SubtitleDocument {
  const left = first.document.cues;
  if (options.mode === "combine") return rebuild(first, sorted([...left, ...second.document.cues]));
  const end = left.reduce((latest, cue) => Math.max(latest, cue.endMs), 0);
  const offset = end + Math.max(0, options.gapMs ?? 0);
  const shifted = second.document.cues.map((cue) => ({
    ...cue,
    startMs: cue.startMs + offset,
    endMs: cue.endMs + offset,
  }));
  return rebuild(first, [...left, ...shifted]);
}

function overlapMs(left: SubtitleCue, right: SubtitleCue): number {
  return Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs);
}

/** Two-language subtitles: each secondary cue joins the primary cue it
 * overlaps most, as a second line below the primary text. Primary cues
 * without a match keep their single line; the primary timing is kept. */
export function dualSubtitles(primary: SubtitleDocument, secondary: SubtitleDocument): string {
  const base = sorted(primary.document.cues);
  const extra = new Map<number, string[]>();
  for (const cue of sorted(secondary.document.cues)) {
    let best = -1;
    let bestOverlap = 0;
    base.forEach((candidate, index) => {
      const overlap = overlapMs(candidate, cue);
      if (overlap > bestOverlap) {
        best = index;
        bestOverlap = overlap;
      }
    });
    if (best >= 0)
      extra.set(best, [...(extra.get(best) ?? []), cue.text.replace(/\s*\n\s*/gu, " ")]);
  }
  const cues = base.map((cue, index) => {
    const second = extra.get(index);
    return second ? { ...cue, text: `${cue.text}\n${second.join(" ")}` } : cue;
  });
  const document = rebuild(primary, cues);
  const srt = createSubtitleDocument({
    id: document.document.id,
    format: "srt",
    roundTrip: "fallback",
    cues: cueInputs(document.document.cues).map((cue) => ({ ...cue, formatData: {} })),
  });
  return convertSubtitle(srt, "srt");
}
