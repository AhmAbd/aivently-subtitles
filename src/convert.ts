import { createSubtitleDocument, type SubtitleDocument } from "./model.js";

export interface SubtitleConversionOptions {
  id: string;
  sourceLanguage?: string | null;
}

export interface SccConversionOptions extends SubtitleConversionOptions {
  frameRate: number;
}

export interface ConversionParityFixture {
  frameRate: number;
  cues: ReadonlyArray<{ startMs: number; endMs: number; text: string }>;
}

export interface ConversionParityResult {
  exactDialogue: true;
  exactOrder: true;
  maximumBoundaryDeltaMs: number;
  maximumAllowedDeltaMs: number;
}

function validFrameRate(value: number): boolean {
  return Number.isFinite(value) && value >= 1 && value <= 120;
}

function timecodeToMs(value: string, frameRate: number): number {
  if (!validFrameRate(frameRate)) throw new Error("subtitle_frame_rate_invalid");
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/u);
  if (!match) throw new Error("subtitle_timecode_invalid");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const frames = Number(match[5]);
  const nominalRate = Math.round(frameRate);
  if (minutes > 59 || seconds > 59 || frames >= nominalRate) {
    throw new Error("subtitle_timecode_invalid");
  }
  if (match[4] === ";") {
    const isDropRate = Math.abs(frameRate - 29.97) < 0.02 || Math.abs(frameRate - 59.94) < 0.02;
    if (!isDropRate) throw new Error("subtitle_drop_frame_invalid");
    const dropFrames = nominalRate === 60 ? 4 : 2;
    const totalMinutes = hours * 60 + minutes;
    const frameNumber =
      (hours * 3600 + minutes * 60 + seconds) * nominalRate +
      frames -
      dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
    return Math.round((frameNumber * 1000) / frameRate);
  }
  return (hours * 3600 + minutes * 60 + seconds) * 1000 + Math.round((frames * 1000) / frameRate);
}

function decodeSccWords(value: string): string {
  const words = value.trim().split(/\s+/u);
  if (words.length === 0 || words.some((word) => !/^[0-9a-f]{4}$/iu.test(word))) {
    throw new Error("subtitle_scc_invalid");
  }
  let text = "";
  for (const word of words) {
    const first = Number.parseInt(word.slice(0, 2), 16) & 0x7f;
    const second = Number.parseInt(word.slice(2), 16) & 0x7f;
    if (first >= 0x10 && first <= 0x1f) continue;
    for (const byte of [first, second]) {
      if (byte === 0) continue;
      if (byte === 0x7f) text += "♪";
      else if (byte >= 0x20 && byte <= 0x7e) text += String.fromCharCode(byte);
      else throw new Error("subtitle_scc_character_invalid");
    }
  }
  return text.trimEnd();
}

export function convertScc(content: string, options: SccConversionOptions): SubtitleDocument {
  if (typeof content !== "string" || !validFrameRate(options.frameRate)) {
    throw new Error("subtitle_scc_invalid");
  }
  const lines = content
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  if (lines[0]?.trim() !== "Scenarist_SCC V1.0") throw new Error("subtitle_scc_header_invalid");
  const entries: Array<{ startMs: number; text: string }> = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d{2}:\d{2}:\d{2}[:;]\d{2})\s+(.+?)\s*$/u);
    if (!match) throw new Error("subtitle_scc_invalid");
    entries.push({
      startMs: timecodeToMs(match[1]!, options.frameRate),
      text: decodeSccWords(match[2]!),
    });
  }
  if (entries.length === 0) throw new Error("subtitle_scc_invalid");
  const cues = entries.flatMap((entry, index) => {
    if (!entry.text.trim()) return [];
    const next = entries.slice(index + 1).find((candidate) => candidate.startMs > entry.startMs);
    const endMs = next?.startMs ?? entry.startMs + 2000;
    if (endMs <= entry.startMs) throw new Error("subtitle_timing_invalid");
    return [
      {
        id: `cue-${index + 1}`,
        ordinal: 0,
        startMs: entry.startMs,
        endMs,
        text: entry.text,
      },
    ];
  });
  cues.forEach((cue, index) => {
    cue.ordinal = index + 1;
  });
  if (cues.length === 0) throw new Error("subtitle_scc_invalid");
  return createSubtitleDocument({
    id: options.id,
    format: "scc",
    sourceLanguage: options.sourceLanguage,
    roundTrip: "fallback",
    metadata: { sccFrameRate: options.frameRate },
    cues,
  });
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function ebuTimeToMs(bytes: Uint8Array, frameRate: number): number {
  if (bytes.length !== 4) throw new Error("subtitle_ebu_stl_invalid");
  const [hours, minutes, seconds, frames] = bytes;
  if (
    hours === undefined ||
    minutes === undefined ||
    seconds === undefined ||
    frames === undefined ||
    minutes > 59 ||
    seconds > 59 ||
    frames >= frameRate
  ) {
    throw new Error("subtitle_ebu_stl_timecode_invalid");
  }
  return (hours * 3600 + minutes * 60 + seconds) * 1000 + Math.round((frames * 1000) / frameRate);
}

function decodeEbuText(bytes: readonly number[]): string {
  let text = "";
  for (const byte of bytes) {
    if (byte === 0x8f) break;
    if (byte === 0x8a) text += "\n";
    else if ((byte >= 0x80 && byte <= 0x9f) || byte === 0) continue;
    else if (byte >= 0x20) text += String.fromCharCode(byte);
  }
  return text.trim();
}

export function convertEbuStl(
  content: Uint8Array,
  options: SubtitleConversionOptions,
): SubtitleDocument {
  if (
    !(content instanceof Uint8Array) ||
    content.length < 1152 ||
    (content.length - 1024) % 128 !== 0
  ) {
    throw new Error("subtitle_ebu_stl_invalid");
  }
  const diskFormatCode = ascii(content.slice(3, 11));
  const format = /^STL(25|30)\.01$/u.exec(diskFormatCode);
  if (!format) throw new Error("subtitle_ebu_stl_format_invalid");
  const frameRate = Number(format[1]);
  const characterCodeTable = ascii(content.slice(12, 14));
  if (characterCodeTable !== "00") throw new Error("subtitle_ebu_stl_character_table_unsupported");

  const grouped = new Map<
    string,
    { number: number; startMs: number; endMs: number; comment: boolean; bytes: number[] }
  >();
  for (let offset = 1024; offset < content.length; offset += 128) {
    const block = content.slice(offset, offset + 128);
    const group = block[0]!;
    const number = (block[1]! << 8) | block[2]!;
    const key = `${group}:${number}`;
    const startMs = ebuTimeToMs(block.slice(5, 9), frameRate);
    const endMs = ebuTimeToMs(block.slice(9, 13), frameRate);
    const existing = grouped.get(key);
    if (existing) {
      if (existing.startMs !== startMs || existing.endMs !== endMs) {
        throw new Error("subtitle_ebu_stl_extension_invalid");
      }
      existing.bytes.push(...block.slice(16));
    } else {
      grouped.set(key, {
        number,
        startMs,
        endMs,
        comment: block[15] === 1,
        bytes: [...block.slice(16)],
      });
    }
  }
  const entries = [...grouped.values()]
    .filter((entry) => !entry.comment)
    .sort((left, right) => left.startMs - right.startMs || left.number - right.number);
  const cues = entries.map((entry, index) => {
    const text = decodeEbuText(entry.bytes);
    if (!text) throw new Error("subtitle_text_empty");
    if (entry.endMs <= entry.startMs) throw new Error("subtitle_timing_invalid");
    return {
      id: `cue-${entry.number || index + 1}`,
      ordinal: index + 1,
      startMs: entry.startMs,
      endMs: entry.endMs,
      text,
    };
  });
  if (cues.length === 0) throw new Error("subtitle_ebu_stl_invalid");
  return createSubtitleDocument({
    id: options.id,
    format: "ebu-stl",
    sourceLanguage: options.sourceLanguage,
    roundTrip: "fallback",
    metadata: { ebuFrameRate: frameRate, ebuCharacterCodeTable: characterCodeTable },
    cues,
  });
}

function normalizedDialogue(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .join("\n")
    .trim();
}

export function validateSubtitleConversionParity(
  document: SubtitleDocument,
  fixture: ConversionParityFixture,
): ConversionParityResult {
  if (!validFrameRate(fixture.frameRate) || document.document.cues.length !== fixture.cues.length) {
    throw new Error("subtitle_conversion_parity_invalid");
  }
  const maximumAllowedDeltaMs = Math.ceil(1000 / fixture.frameRate);
  let maximumBoundaryDeltaMs = 0;
  for (let index = 0; index < fixture.cues.length; index += 1) {
    const actual = document.document.cues[index]!;
    const expected = fixture.cues[index]!;
    if (
      actual.ordinal !== index + 1 ||
      normalizedDialogue(actual.text) !== normalizedDialogue(expected.text)
    ) {
      throw new Error("subtitle_conversion_parity_invalid");
    }
    maximumBoundaryDeltaMs = Math.max(
      maximumBoundaryDeltaMs,
      Math.abs(actual.startMs - expected.startMs),
      Math.abs(actual.endMs - expected.endMs),
    );
  }
  if (maximumBoundaryDeltaMs > maximumAllowedDeltaMs) {
    throw new Error("subtitle_conversion_parity_invalid");
  }
  return { exactDialogue: true, exactOrder: true, maximumBoundaryDeltaMs, maximumAllowedDeltaMs };
}

export function subtitleConversionCapabilities(): Readonly<Record<"scc" | "ebu-stl", boolean>> {
  return { scc: true, "ebu-stl": true };
}
