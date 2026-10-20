import type { TimedDocumentV2 } from "./types.js";

export type SubtitleDocument = TimedDocumentV2;
export type SubtitleFormat = TimedDocumentV2["document"]["format"]["detected"];
export type SubtitleCue = TimedDocumentV2["document"]["cues"][number];

export interface SubtitleCueInput {
  id: string;
  ordinal: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string | null;
  style?: string | null;
  formatData?: Record<string, unknown>;
}

export interface SubtitleDocumentInput {
  id: string;
  format: SubtitleFormat;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
  declaredExtension?: string | null;
  declaredMediaType?: string | null;
  roundTrip?: "preserve" | "fallback";
  metadata?: Record<string, unknown>;
  cues: readonly SubtitleCueInput[];
}

export type DocumentOperation =
  | { type: "replace_text"; cueId: string; text: string }
  | { type: "restore"; document: SubtitleDocument["document"] };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function lineBreaks(text: string): number[] {
  const positions: number[] = [];
  let offset = 0;
  for (const line of text.split("\n").slice(0, -1)) {
    offset += line.length;
    positions.push(offset);
    offset += 1;
  }
  return positions;
}

function cueFromInput(input: SubtitleCueInput): SubtitleCue {
  return {
    id: input.id,
    ordinal: input.ordinal,
    startMs: input.startMs,
    endMs: input.endMs,
    text: input.text,
    ...(input.speaker === undefined ? {} : { speaker: input.speaker }),
    ...(input.style === undefined ? {} : { style: input.style }),
    lineBreaks: lineBreaks(input.text),
    tags: [],
    placeholders: [],
    formatData: input.formatData ?? {},
  };
}

export function validateSubtitleDocument(document: SubtitleDocument): string[] {
  const errors: string[] = [];
  if (document.version !== "v2") errors.push("document_version_invalid");
  if (document.document.sourceKind !== "subtitle") errors.push("source_kind_invalid");
  if (!document.document.id) errors.push("document_id_required");
  if (!Number.isSafeInteger(document.document.version) || document.document.version < 1) {
    errors.push("document_revision_invalid");
  }

  const ids = new Set<string>();
  const ordinals = new Set<number>();
  let previousOrdinal = 0;
  for (const cue of document.document.cues) {
    if (!cue.id) errors.push("cue_id_invalid");
    else if (ids.has(cue.id)) errors.push("cue_id_duplicate");
    ids.add(cue.id);
    if (!Number.isSafeInteger(cue.ordinal) || cue.ordinal < 1 || ordinals.has(cue.ordinal)) {
      errors.push("cue_ordinal_invalid");
    }
    ordinals.add(cue.ordinal);
    if (cue.ordinal <= previousOrdinal) errors.push("cue_order_invalid");
    previousOrdinal = cue.ordinal;
    if (
      !Number.isSafeInteger(cue.startMs) ||
      !Number.isSafeInteger(cue.endMs) ||
      cue.startMs < 0 ||
      cue.endMs <= cue.startMs
    ) {
      errors.push("cue_timing_invalid");
    }
    const expectedLineBreaks = lineBreaks(cue.text);
    if (
      cue.lineBreaks.length !== expectedLineBreaks.length ||
      cue.lineBreaks.some((offset, index) => offset !== expectedLineBreaks[index])
    ) {
      errors.push("cue_line_breaks_invalid");
    }
  }
  return [...new Set(errors)];
}

export function createSubtitleDocument(input: SubtitleDocumentInput): SubtitleDocument {
  const document: SubtitleDocument = {
    version: "v2",
    document: {
      id: input.id,
      version: 1,
      sourceKind: "subtitle",
      sourceLanguage: input.sourceLanguage ?? null,
      targetLanguage: input.targetLanguage ?? null,
      format: {
        detected: input.format,
        declaredExtension: input.declaredExtension ?? null,
        declaredMediaType: input.declaredMediaType ?? null,
        roundTrip: input.roundTrip ?? "preserve",
        metadata: input.metadata ?? {},
      },
      cues: input.cues.map(cueFromInput),
      words: [],
      warnings: [],
    },
  };
  const errors = validateSubtitleDocument(document);
  if (errors.length > 0) throw new Error("subtitle_invalid");
  return document;
}

export function applyDocumentOperation(
  current: SubtitleDocument,
  expectedVersion: number,
  operation: DocumentOperation,
): SubtitleDocument {
  if (current.document.version !== expectedVersion) {
    throw new Error("document_version_conflict");
  }
  const next = clone(current);
  next.document.version += 1;
  if (operation.type === "replace_text") {
    const cue = next.document.cues.find((candidate) => candidate.id === operation.cueId);
    if (!cue) throw new Error("cue_not_found");
    cue.text = operation.text;
    cue.lineBreaks = lineBreaks(operation.text);
  } else {
    if (operation.document.id !== current.document.id) throw new Error("document_id_conflict");
    next.document = clone(operation.document);
    next.document.version = current.document.version + 1;
  }
  const errors = validateSubtitleDocument(next);
  if (errors.length > 0) throw new Error("subtitle_invalid");
  return next;
}
