import { createSubtitleDocument, type SubtitleDocument, type SubtitleFormat } from "./model.js";

export interface ParseSubtitleOptions {
  id: string;
  format: SubtitleFormat;
  sourceLanguage?: string | null;
  declaredExtension?: string | null;
  declaredMediaType?: string | null;
  allowPlainText?: boolean;
}

interface ParsedCue {
  id: string;
  ordinal: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string | null;
  style?: string | null;
  formatData?: Record<string, unknown>;
}

interface ParsedSubtitle {
  cues: ParsedCue[];
  metadata: Record<string, unknown>;
  roundTrip?: "preserve" | "fallback";
}

const MAX_SUBTITLE_SOURCE_LINES = 50_000;
const MAX_SUBTITLE_SOURCE_LINE_CODE_UNITS = 64 * 1024;
const MAX_SUBTITLE_CUES = 10_000;
const MAX_SUBTITLE_CUE_TEXT_CODE_UNITS = 64 * 1024;
const MAX_ASS_EVENT_FIELDS = 64;
const MAX_ASS_METADATA_LINES = 1_024;
const MAX_ASS_OVERRIDES_PER_CUE = 256;
const MAX_LRC_TIMESTAMPS_PER_LINE = 256;
const MAX_LRC_METADATA_TAGS = 1_024;
const MAX_MARKUP_TAGS_PER_CUE = 1_024;
const MAX_MARKUP_TAG_CODE_UNITS = 8 * 1024;

class ParserComplexityBudget {
  private cues = 0;

  constructor(content: string) {
    let sourceLines = 1;
    let lineStart = 0;
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] !== "\n") continue;
      this.assertSourceLineLength(index - lineStart);
      sourceLines += 1;
      if (sourceLines > MAX_SUBTITLE_SOURCE_LINES) throw new Error("subtitle_complexity_limit");
      lineStart = index + 1;
    }
    this.assertSourceLineLength(content.length - lineStart);
  }

  reserveCue(text: string): void {
    if (text.length > MAX_SUBTITLE_CUE_TEXT_CODE_UNITS || this.cues >= MAX_SUBTITLE_CUES) {
      throw new Error("subtitle_complexity_limit");
    }
    this.cues += 1;
  }

  private assertSourceLineLength(length: number): void {
    if (length > MAX_SUBTITLE_SOURCE_LINE_CODE_UNITS) {
      throw new Error("subtitle_complexity_limit");
    }
  }
}

function timeToMs(value: string, separator: "." | ","): number {
  const valueTrimmed = value.trim();
  const long = valueTrimmed.match(/^(?:(\d{2}):)?(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/u);
  const short = valueTrimmed.match(/^(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/u);
  if (!long && !(short && separator === ".")) throw new Error("subtitle_timestamp_invalid");
  const hours = Number(long?.[1] ?? 0);
  const minutes = Number(long?.[2] ?? short?.[1]);
  const seconds = Number(long?.[3] ?? short?.[2]);
  const millis = Number((long?.[4] ?? short?.[3] ?? "0").padEnd(3, "0"));
  if (minutes > 59 || seconds > 59 || (separator === "," && !value.includes(","))) {
    throw new Error("subtitle_timestamp_invalid");
  }
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function parseTiming(
  line: string,
  format: "srt" | "vtt",
): { startMs: number; endMs: number; settings: string | null } {
  const match = line.trim().match(/^(\S+)\s+-->\s+(\S+)(?:\s+(.*))?$/u);
  if (!match) throw new Error("subtitle_timing_invalid");
  const separator = format === "srt" ? "," : ".";
  const startToken = match[1];
  const endToken = match[2];
  if (!startToken || !endToken) throw new Error("subtitle_timing_invalid");
  const start = timeToMs(startToken, separator);
  const end = timeToMs(endToken, separator);
  if (end <= start) throw new Error("subtitle_timing_invalid");
  return { startMs: start, endMs: end, settings: match[3]?.trim() || null };
}

function parseSrt(content: string, budget: ParserComplexityBudget) {
  const blocks = content
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .trim()
    .split(/\n{2,}/u)
    .filter(Boolean);
  if (blocks.length === 0) throw new Error("subtitle_invalid");
  return blocks.map((block, index) => {
    const lines = block.split("\n");
    if (!/^\d+$/u.test(lines[0] ?? "")) throw new Error("subtitle_index_invalid");
    const { startMs, endMs, settings } = parseTiming(lines[1] ?? "", "srt");
    if (settings) throw new Error("subtitle_timing_invalid");
    const text = lines.slice(2).join("\n");
    if (!text.trim()) throw new Error("subtitle_text_empty");
    budget.reserveCue(text);
    return {
      id: `cue-${lines[0]}`,
      ordinal: index + 1,
      startMs,
      endMs,
      text,
      formatData: { srtIndex: lines[0] },
    };
  });
}

function parseVtt(content: string, budget: ParserComplexityBudget) {
  const lines = content
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  if (!/^WEBVTT(?:\s|$)/u.test(lines[0]?.trim() ?? "")) throw new Error("vtt_header_required");
  const header = lines[0]?.trim() ?? "WEBVTT";
  const headerLines: string[] = [];
  let cursor = 1;
  while (cursor < lines.length && lines[cursor]?.trim()) {
    headerLines.push(lines[cursor] ?? "");
    cursor += 1;
  }
  if (cursor >= lines.length && headerLines.length > 0) throw new Error("subtitle_invalid");

  const cues: Array<{
    id: string;
    ordinal: number;
    startMs: number;
    endMs: number;
    text: string;
    formatData: Record<string, unknown>;
  }> = [];
  const blocks: Array<{ beforeOrdinal: number; lines: string[] }> = [];
  let index = 1;
  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor]?.trim()) cursor += 1;
    if (cursor >= lines.length) break;
    const first = lines[cursor]?.trim() ?? "";
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/u.test(first)) {
      const block: string[] = [];
      while (cursor < lines.length && lines[cursor]?.trim()) {
        block.push(lines[cursor] ?? "");
        cursor += 1;
      }
      blocks.push({ beforeOrdinal: index, lines: block });
      continue;
    }
    let cueIdentifier: string | undefined;
    if (!first.includes("-->")) {
      cueIdentifier = first;
      cursor += 1;
    }
    const { startMs, endMs, settings } = parseTiming(lines[cursor] ?? "", "vtt");
    cursor += 1;
    const textLines: string[] = [];
    while (cursor < lines.length && lines[cursor]?.trim()) {
      textLines.push(lines[cursor] ?? "");
      cursor += 1;
    }
    const text = textLines.join("\n");
    if (!text.trim()) throw new Error("subtitle_text_empty");
    budget.reserveCue(text);
    cues.push({
      id: `cue-${index}`,
      ordinal: index,
      startMs,
      endMs,
      text,
      formatData: {
        ...(cueIdentifier ? { vttCueIdentifier: cueIdentifier } : {}),
        ...(settings ? { vttSettings: settings } : {}),
      },
    });
    index += 1;
  }
  if (cues.length === 0) throw new Error("subtitle_invalid");
  return {
    cues,
    metadata: { vttHeader: header, vttHeaderLines: headerLines, vttBlocks: blocks },
  };
}

function normalizedLines(content: string): string[] {
  return content
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
}

function clockToMs(value: string): number {
  const normalized = value.trim();
  const clock = normalized.match(/^(\d{1,3}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/u);
  if (!clock) throw new Error("subtitle_timestamp_invalid");
  const hours = Number(clock[1]);
  const minutes = Number(clock[2]);
  const seconds = Number(clock[3]);
  const millis = Number((clock[4] ?? "0").padEnd(3, "0"));
  if (minutes > 59 || seconds > 59) throw new Error("subtitle_timestamp_invalid");
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function assTimeToMs(value: string): number {
  const match = value.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})\.(\d{2})$/u);
  if (!match) throw new Error("subtitle_timestamp_invalid");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) throw new Error("subtitle_timestamp_invalid");
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(match[4]) * 10;
}

function splitLimited(value: string, count: number): string[] {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 1; index < count; index += 1) {
    const comma = value.indexOf(",", offset);
    if (comma < 0) throw new Error("subtitle_invalid");
    fields.push(value.slice(offset, comma));
    offset = comma + 1;
  }
  fields.push(value.slice(offset));
  return fields;
}

function splitAssEventFields(value: string): string[] {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ",") continue;
    if (fields.length >= MAX_ASS_EVENT_FIELDS - 1) throw new Error("subtitle_complexity_limit");
    fields.push(value.slice(offset, index).trim());
    offset = index + 1;
  }
  if (fields.length >= MAX_ASS_EVENT_FIELDS) throw new Error("subtitle_complexity_limit");
  fields.push(value.slice(offset).trim());
  return fields;
}

function decodeAssText(value: string): string {
  return value.replaceAll(/\\[Nn]/gu, "\n").replaceAll("\\h", " ");
}

function extractAssOverrides(value: string): {
  text: string;
  overrides: Array<{ offset: number; value: string }>;
} {
  const overrides: Array<{ offset: number; value: string }> = [];
  const textParts: string[] = [];
  let textLength = 0;
  let plainStart = 0;
  let overrideStart = -1;
  let pendingOverridePrefixes = 0;
  const appendDecoded = (segment: string) => {
    const decoded = decodeAssText(segment);
    textParts.push(decoded);
    textLength += decoded.length;
  };
  for (let index = 0; index < value.length; index += 1) {
    if (overrideStart < 0) {
      if (value[index] === "{" && value[index + 1] === "\\") {
        overrideStart = index;
        pendingOverridePrefixes = 1;
        index += 1;
      }
      continue;
    }
    if (value[index] === "{" && value[index + 1] === "\\") {
      if (pendingOverridePrefixes >= MAX_ASS_OVERRIDES_PER_CUE) {
        throw new Error("subtitle_complexity_limit");
      }
      pendingOverridePrefixes += 1;
      index += 1;
      continue;
    }
    if (value[index] !== "}") continue;
    appendDecoded(value.slice(plainStart, overrideStart));
    if (overrides.length >= MAX_ASS_OVERRIDES_PER_CUE) {
      throw new Error("subtitle_complexity_limit");
    }
    overrides.push({ offset: textLength, value: value.slice(overrideStart, index + 1) });
    plainStart = index + 1;
    overrideStart = -1;
    pendingOverridePrefixes = 0;
  }
  appendDecoded(value.slice(plainStart));
  return { text: textParts.join(""), overrides };
}

function parseAss(content: string, budget: ParserComplexityBudget): ParsedSubtitle {
  const lines = normalizedLines(content);
  let section = "";
  let fields: string[] | null = null;
  let eventFormat: string[] | null = null;
  let styleSection: "V4+ Styles" | "V4 Styles" | null = null;
  const scriptInfoLines: string[] = [];
  const styleLines: string[] = [];
  const cues: ParsedCue[] = [];
  let fallback = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1]?.toLowerCase() ?? "";
      if (section === "v4+ styles") styleSection = "V4+ Styles";
      else if (section === "v4 styles") styleSection = "V4 Styles";
      else if (!["script info", "events"].includes(section)) fallback = true;
      continue;
    }
    if (!trimmed) continue;
    if (section === "script info") {
      if (scriptInfoLines.length + styleLines.length >= MAX_ASS_METADATA_LINES) {
        throw new Error("subtitle_complexity_limit");
      }
      scriptInfoLines.push(line.trimEnd());
      continue;
    }
    if (section === "v4+ styles" || section === "v4 styles") {
      if (scriptInfoLines.length + styleLines.length >= MAX_ASS_METADATA_LINES) {
        throw new Error("subtitle_complexity_limit");
      }
      styleLines.push(line.trimEnd());
      continue;
    }
    if (section !== "events") {
      fallback = true;
      continue;
    }
    if (/^format\s*:/iu.test(trimmed)) {
      eventFormat = splitAssEventFields(trimmed.replace(/^format\s*:/iu, ""));
      fields = eventFormat.map((field) => field.toLowerCase());
      if (
        fields.length < 3 ||
        fields.at(-1) !== "text" ||
        !fields.includes("start") ||
        !fields.includes("end") ||
        new Set(fields).size !== fields.length
      ) {
        throw new Error("ass_format_invalid");
      }
      continue;
    }
    if (!/^dialogue\s*:/iu.test(trimmed)) {
      fallback = true;
      continue;
    }
    if (!fields) throw new Error("ass_format_required");
    const values = splitLimited(trimmed.replace(/^dialogue\s*:/iu, "").trimStart(), fields.length);
    const value = Object.fromEntries(
      fields.map((field, index) => [field, values[index]?.trim() ?? ""]),
    );
    if (!value.start || !value.end || value.text === undefined) throw new Error("subtitle_invalid");
    const startMs = assTimeToMs(value.start);
    const endMs = assTimeToMs(value.end);
    if (endMs <= startMs) throw new Error("subtitle_timing_invalid");
    const { text, overrides } = extractAssOverrides(value.text);
    if (overrides.length > 0) fallback = true;
    if (!text.trim()) throw new Error("subtitle_text_empty");
    const assEventFields = Object.fromEntries(
      fields
        .filter((field) => !["start", "end", "style", "name", "text"].includes(field))
        .map((field) => [field, value[field] ?? ""]),
    );
    budget.reserveCue(text);
    cues.push({
      id: `cue-${cues.length + 1}`,
      ordinal: cues.length + 1,
      startMs,
      endMs,
      text,
      speaker: value.name || null,
      style: value.style || null,
      formatData: { assEventFields, assOverrides: overrides },
    });
  }
  if (cues.length === 0) throw new Error("subtitle_invalid");
  if (!eventFormat) throw new Error("ass_format_required");
  const assKind = /^ScriptType:\s*v4\.00\+$/imu.test(content) ? "ass" : "ssa";
  return {
    cues,
    metadata: {
      assKind,
      assScriptInfoLines: scriptInfoLines,
      assStyleSection: styleSection,
      assStyleLines: styleLines,
      assEventFormat: eventFormat,
    },
    roundTrip: fallback ? "fallback" : "preserve",
  };
}

function parseSbv(content: string, budget: ParserComplexityBudget): ParsedSubtitle {
  const blocks = normalizedLines(content)
    .join("\n")
    .trim()
    .split(/\n{2,}/u);
  const cues = blocks.map((block, index) => {
    const lines = block.split("\n");
    const timing = lines[0]?.match(/^\s*([^,]+),([^,]+)\s*$/u);
    if (!timing) throw new Error("subtitle_timing_invalid");
    const startMs = clockToMs(timing[1]!);
    const endMs = clockToMs(timing[2]!);
    const text = lines.slice(1).join("\n");
    if (endMs <= startMs) throw new Error("subtitle_timing_invalid");
    if (!text.trim()) throw new Error("subtitle_text_empty");
    budget.reserveCue(text);
    return { id: `cue-${index + 1}`, ordinal: index + 1, startMs, endMs, text };
  });
  if (cues.length === 0) throw new Error("subtitle_invalid");
  return { cues, metadata: {} };
}

function deriveEndTimes(
  rows: Array<{ startMs: number; text: string; formatData?: Record<string, unknown> }>,
): ParsedCue[] {
  return rows.map((row, index) => {
    const next = rows[index + 1]?.startMs;
    const endMs = next !== undefined ? next : row.startMs + 2000;
    if (endMs <= row.startMs || !row.text.trim()) throw new Error("subtitle_timing_invalid");
    return { id: `cue-${index + 1}`, ordinal: index + 1, endMs, ...row };
  });
}

function parseLrc(content: string, budget: ParserComplexityBudget): ParsedSubtitle {
  const rows: Array<{ startMs: number; text: string }> = [];
  const tags: string[] = [];
  for (const line of normalizedLines(content)) {
    const metadata = line.match(/^\[([a-z]{2,}):([^\]]*)\]\s*$/iu);
    if (metadata) {
      if (tags.length >= MAX_LRC_METADATA_TAGS) throw new Error("subtitle_complexity_limit");
      tags.push(`${metadata[1]}:${metadata[2]}`);
      continue;
    }
    const startTimes: number[] = [];
    let leadingTimestampEnd = 0;
    for (const timestamp of line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/gu)) {
      if (startTimes.length >= MAX_LRC_TIMESTAMPS_PER_LINE) {
        throw new Error("subtitle_complexity_limit");
      }
      const seconds = Number(timestamp[2]);
      if (seconds > 59) throw new Error("subtitle_timestamp_invalid");
      const fraction = Number((timestamp[3] ?? "0").padEnd(3, "0"));
      startTimes.push((Number(timestamp[1]) * 60 + seconds) * 1000 + fraction);
      if ((timestamp.index ?? -1) === leadingTimestampEnd) {
        leadingTimestampEnd += timestamp[0]?.length ?? 0;
      }
    }
    if (startTimes.length === 0) continue;
    const text = line.slice(leadingTimestampEnd);
    for (const startMs of startTimes) {
      budget.reserveCue(text);
      rows.push({ startMs, text });
    }
  }
  rows.sort((left, right) => left.startMs - right.startMs);
  if (rows.length === 0) throw new Error("subtitle_invalid");
  return { cues: deriveEndTimes(rows), metadata: { lrcTags: tags } };
}

function parseMicroDvd(content: string, budget: ParserComplexityBudget): ParsedSubtitle {
  let frameRate: number | null = null;
  const rows: Array<{ startFrame: number; endFrame: number; text: string }> = [];
  for (const line of normalizedLines(content).filter((value) => value.trim())) {
    const match = line.match(/^\{(\d+)\}\{(\d+)\}(.*)$/u);
    if (!match) throw new Error("subtitle_invalid");
    const startFrame = Number(match[1]);
    const endFrame = Number(match[2]);
    const text = match[3] ?? "";
    if (startFrame === 1 && endFrame === 1 && /^\d+(?:\.\d+)?$/u.test(text.trim())) {
      frameRate = Number(text.trim());
      continue;
    }
    budget.reserveCue(text);
    rows.push({ startFrame, endFrame, text: text.replaceAll("|", "\n") });
  }
  if (!frameRate || !Number.isFinite(frameRate) || frameRate < 1 || frameRate > 120) {
    throw new Error("subtitle_frame_rate_required");
  }
  const cues = rows.map((row, index) => {
    if (row.endFrame <= row.startFrame || !row.text.trim())
      throw new Error("subtitle_timing_invalid");
    return {
      id: `cue-${index + 1}`,
      ordinal: index + 1,
      startMs: Math.round((row.startFrame * 1000) / frameRate),
      endMs: Math.round((row.endFrame * 1000) / frameRate),
      text: row.text,
      formatData: { microDvdStartFrame: row.startFrame, microDvdEndFrame: row.endFrame },
    };
  });
  if (cues.length === 0) throw new Error("subtitle_invalid");
  return { cues, metadata: { microDvdFrameRate: frameRate } };
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    if (named[name.toLowerCase()] === undefined) throw new Error("subtitle_entity_invalid");
    return named[name.toLowerCase()]!;
  });
}

function isMarkupWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\r" || value === "\n" || value === "\f";
}

function hasAsciiCaseInsensitiveAt(value: string, offset: number, expected: string): boolean {
  if (offset + expected.length > value.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const code = value.charCodeAt(offset + index);
    const normalized = code >= 65 && code <= 90 ? code + 32 : code;
    if (normalized !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function isLineBreakMarkupTag(value: string, start: number, end: number): boolean {
  return /^br\s*\/?$/iu.test(value.slice(start + 1, end).trim());
}

function markupText(value: string): string {
  const textParts: string[] = [];
  let textStart = 0;
  let tags = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "<") continue;
    const scanEnd = Math.min(value.length, index + MAX_MARKUP_TAG_CODE_UNITS + 1);
    let tagEnd = -1;
    for (let cursor = index + 1; cursor < scanEnd; cursor += 1) {
      if (value[cursor] === ">") {
        tagEnd = cursor;
        break;
      }
    }
    if (tagEnd < 0) {
      if (value.length - index > MAX_MARKUP_TAG_CODE_UNITS) {
        throw new Error("subtitle_complexity_limit");
      }
      break;
    }
    if (tags >= MAX_MARKUP_TAGS_PER_CUE) throw new Error("subtitle_complexity_limit");
    textParts.push(value.slice(textStart, index));
    if (isLineBreakMarkupTag(value, index, tagEnd)) textParts.push("\n");
    tags += 1;
    textStart = tagEnd + 1;
    index = tagEnd;
  }
  textParts.push(value.slice(textStart));
  return decodeEntities(textParts.join("").trim());
}

function timedMarkupTime(value: string): number {
  if (/^\d+(?:\.\d+)?s$/u.test(value.trim()))
    return Math.round(Number(value.trim().slice(0, -1)) * 1000);
  return clockToMs(value);
}

function findTtmlParagraphOpening(value: string, start: number): number {
  for (let index = start; index < value.length - 2; index += 1) {
    if (
      value[index] === "<" &&
      hasAsciiCaseInsensitiveAt(value, index + 1, "p") &&
      isMarkupWhitespace(value[index + 2])
    ) {
      return index;
    }
    if (
      value[index] === "<" &&
      hasAsciiCaseInsensitiveAt(value, index + 1, "p") &&
      value[index + 2] === ">"
    ) {
      return index;
    }
  }
  return -1;
}

function findTtmlOpeningEnd(value: string, start: number): number {
  const scanEnd = Math.min(value.length, start + MAX_MARKUP_TAG_CODE_UNITS + 1);
  for (let index = start; index < scanEnd; index += 1) {
    if (value[index] === ">") return index;
  }
  throw new Error("subtitle_complexity_limit");
}

function findTtmlParagraphClosing(
  value: string,
  start: number,
): { start: number; end: number } | null {
  for (let index = start; index < value.length - 3; index += 1) {
    if (
      value[index] !== "<" ||
      value[index + 1] !== "/" ||
      !hasAsciiCaseInsensitiveAt(value, index + 2, "p")
    ) {
      continue;
    }
    let end = index + 3;
    while (isMarkupWhitespace(value[end])) end += 1;
    if (value[end] === ">") return { start: index, end };
  }
  return null;
}

function parseTtml(content: string, budget: ParserComplexityBudget): ParsedSubtitle {
  if (/<!DOCTYPE|<!ENTITY/iu.test(content) || !/<tt(?:\s|>)/iu.test(content)) {
    throw new Error("subtitle_xml_invalid");
  }
  const cues: ParsedCue[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const opening = findTtmlParagraphOpening(content, cursor);
    if (opening < 0) break;
    const openingEnd = findTtmlOpeningEnd(content, opening + 2);
    const closing = findTtmlParagraphClosing(content, openingEnd + 1);
    if (!closing) throw new Error("subtitle_complexity_limit");
    const attributes = content.slice(opening + 2, openingEnd);
    const begin = attributes.match(/\bbegin\s*=\s*["']([^"']+)["']/iu)?.[1];
    const end = attributes.match(/\bend\s*=\s*["']([^"']+)["']/iu)?.[1];
    const duration = attributes.match(/\bdur\s*=\s*["']([^"']+)["']/iu)?.[1];
    if (!begin || (!end && !duration)) throw new Error("subtitle_timing_invalid");
    const startMs = timedMarkupTime(begin);
    const endMs = end ? timedMarkupTime(end) : startMs + timedMarkupTime(duration!);
    const text = markupText(content.slice(openingEnd + 1, closing.start));
    if (endMs <= startMs) throw new Error("subtitle_timing_invalid");
    if (!text.trim()) throw new Error("subtitle_text_empty");
    budget.reserveCue(text);
    cues.push({
      id: `cue-${cues.length + 1}`,
      ordinal: cues.length + 1,
      startMs,
      endMs,
      text,
      style: attributes.match(/\b(?:style|tts:style)\s*=\s*["']([^"']+)["']/iu)?.[1] ?? null,
    });
    cursor = closing.end + 1;
  }
  if (cues.length === 0) throw new Error("subtitle_invalid");
  return { cues, metadata: {} };
}

function parseSami(content: string, budget: ParserComplexityBudget): ParsedSubtitle {
  if (/<!DOCTYPE|<!ENTITY/iu.test(content) || !/<sami(?:\s|>)/iu.test(content)) {
    throw new Error("subtitle_xml_invalid");
  }
  const syncs = content.matchAll(/<sync\b[^>]*\bstart\s*=\s*["']?(\d+)["']?[^>]*>/giu);
  let current = syncs.next();
  let next = syncs.next();
  if (current.done || next.done) throw new Error("subtitle_timing_invalid");
  const cues: ParsedCue[] = [];
  while (!current.done && !next.done) {
    const currentMatch = current.value;
    const nextMatch = next.value;
    const segment = content.slice(
      (currentMatch.index ?? 0) + currentMatch[0].length,
      nextMatch.index ?? content.length,
    );
    const paragraph = segment.match(/<p\b([^>]*)>([\s\S]*?)(?:<\/p\s*>|$)/iu);
    if (paragraph) {
      const text = markupText(paragraph[2] ?? "").trim();
      if (text) {
        const startMs = Number(currentMatch[1]);
        const endMs = Number(nextMatch[1]);
        if (endMs <= startMs) throw new Error("subtitle_timing_invalid");
        budget.reserveCue(text);
        cues.push({
          id: `cue-${cues.length + 1}`,
          ordinal: cues.length + 1,
          startMs,
          endMs,
          text,
          formatData: {
            samiClass: paragraph[1]?.match(/\bclass\s*=\s*["']?([^\s"'>]+)/iu)?.[1] ?? null,
          },
        });
      }
    }
    current = next;
    next = syncs.next();
  }
  if (cues.length === 0) throw new Error("subtitle_invalid");
  return { cues, metadata: {} };
}

function parseMpl2(content: string, budget: ParserComplexityBudget): ParsedSubtitle {
  const cues = normalizedLines(content)
    .filter((line) => line.trim())
    .map((line, index) => {
      const match = line.match(/^\[(\d+)\]\[(\d+)\](.*)$/u);
      if (!match) throw new Error("subtitle_invalid");
      const startMs = Number(match[1]) * 100;
      const endMs = Number(match[2]) * 100;
      const text = (match[3] ?? "").replaceAll("|", "\n");
      if (endMs <= startMs) throw new Error("subtitle_timing_invalid");
      if (!text.trim()) throw new Error("subtitle_text_empty");
      budget.reserveCue(text);
      return { id: `cue-${index + 1}`, ordinal: index + 1, startMs, endMs, text };
    });
  if (cues.length === 0) throw new Error("subtitle_invalid");
  return { cues, metadata: {} };
}

function parseTmp(content: string, budget: ParserComplexityBudget): ParsedSubtitle {
  const rows = normalizedLines(content)
    .filter((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(\d{2}):(\d{2}):(\d{2}):(.*)$/u);
      if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) {
        throw new Error("subtitle_timestamp_invalid");
      }
      const text = (match[4] ?? "").replaceAll("|", "\n");
      budget.reserveCue(text);
      return {
        startMs: ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000,
        text,
      };
    });
  if (rows.length === 0) throw new Error("subtitle_invalid");
  return { cues: deriveEndTimes(rows), metadata: {} };
}

function csvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const value = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      if (row.some((entry) => entry.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("subtitle_csv_invalid");
  row.push(field);
  if (row.some((entry) => entry.length > 0)) rows.push(row);
  return rows;
}

function parseCsv(content: string, budget: ParserComplexityBudget): ParsedSubtitle {
  const rows = csvRows(content);
  const header = rows.shift()?.map((value) => value.trim().toLowerCase()) ?? [];
  const startIndex = header.indexOf("start");
  const endIndex = header.indexOf("end");
  const textIndex = header.indexOf("text");
  if (startIndex < 0 || endIndex < 0 || textIndex < 0) throw new Error("subtitle_csv_invalid");
  const speakerIndex = header.indexOf("speaker");
  const styleIndex = header.indexOf("style");
  const cues = rows.map((row, index) => {
    const startMs = clockToMs(row[startIndex] ?? "");
    const endMs = clockToMs(row[endIndex] ?? "");
    const text = row[textIndex] ?? "";
    if (endMs <= startMs) throw new Error("subtitle_timing_invalid");
    if (!text.trim()) throw new Error("subtitle_text_empty");
    budget.reserveCue(text);
    return {
      id: `cue-${index + 1}`,
      ordinal: index + 1,
      startMs,
      endMs,
      text,
      speaker: speakerIndex >= 0 ? row[speakerIndex] || null : null,
      style: styleIndex >= 0 ? row[styleIndex] || null : null,
    };
  });
  if (cues.length === 0) throw new Error("subtitle_invalid");
  return { cues, metadata: { csvHeader: ["Start", "End", "Text", "Speaker", "Style"] } };
}

function parsePlain(content: string, budget: ParserComplexityBudget): ParsedSubtitle {
  const rows = normalizedLines(content).filter((line) => line.trim());
  if (rows.length === 0) throw new Error("subtitle_invalid");
  return {
    cues: rows.map((text, index) => {
      budget.reserveCue(text);
      return {
        id: `cue-${index + 1}`,
        ordinal: index + 1,
        startMs: index * 2000,
        endMs: (index + 1) * 2000,
        text,
      };
    }),
    metadata: { syntheticTiming: true },
  };
}

export function subtitleInputCapabilities(): Readonly<Record<SubtitleFormat, boolean>> {
  return {
    srt: true,
    vtt: true,
    ass: true,
    sbv: true,
    lrc: true,
    sub: true,
    ttml: true,
    sami: true,
    mpl2: true,
    tmp: true,
    csv: true,
    scc: false,
    "ebu-stl": false,
    plain: false,
  };
}

export function parseSubtitle(content: string, options: ParseSubtitleOptions): SubtitleDocument {
  if (typeof content !== "string" || content.trim().length === 0) throw new Error("subtitle_empty");
  if (options.format === "plain" && !options.allowPlainText) throw new Error("plain_text_disabled");
  const budget = new ParserComplexityBudget(content);
  let parsed: ParsedSubtitle;
  if (options.format === "srt") parsed = { cues: parseSrt(content, budget), metadata: {} };
  else if (options.format === "vtt") parsed = parseVtt(content, budget);
  else if (options.format === "ass") parsed = parseAss(content, budget);
  else if (options.format === "sbv") parsed = parseSbv(content, budget);
  else if (options.format === "lrc") parsed = parseLrc(content, budget);
  else if (options.format === "sub") parsed = parseMicroDvd(content, budget);
  else if (options.format === "ttml") parsed = parseTtml(content, budget);
  else if (options.format === "sami") parsed = parseSami(content, budget);
  else if (options.format === "mpl2") parsed = parseMpl2(content, budget);
  else if (options.format === "tmp") parsed = parseTmp(content, budget);
  else if (options.format === "csv") parsed = parseCsv(content, budget);
  else if (options.format === "plain") parsed = parsePlain(content, budget);
  else throw new Error("subtitle_conversion_required");
  return createSubtitleDocument({
    id: options.id,
    format: options.format,
    sourceLanguage: options.sourceLanguage,
    declaredExtension: options.declaredExtension,
    declaredMediaType: options.declaredMediaType,
    roundTrip: parsed.roundTrip,
    cues: parsed.cues,
    metadata: parsed.metadata,
  });
}
