import { validateSubtitleDocument, type SubtitleCue, type SubtitleDocument } from "./model.js";
import type { TimedDocumentV3 } from "./types.js";

export interface WarningConstraints {
  maxCharsPerLine?: number;
  maxLinesPerCue?: number;
  minCueDurationMs?: number;
  maxCueDurationMs?: number;
  maxReadingSpeed?: number;
}

export type EditOperation =
  | {
      type: "update_cue";
      cueId: string;
      patch: {
        text?: string;
        startMs?: number;
        endMs?: number;
        speaker?: string | null;
        style?: string | null;
      };
    }
  | { type: "split"; cueId: string; newCueId: string; textOffset: number; splitAtMs: number }
  | { type: "merge"; cueIds: readonly [string, string]; separator?: " " | "\n" }
  | { type: "nudge_timing"; cueIds: readonly string[]; deltaMs: number }
  | {
      type: "find_replace";
      find: string;
      replace: string;
      cueIds?: readonly string[];
      caseSensitive?: boolean;
    };

export type SessionCommand = EditOperation | { type: "undo" } | { type: "redo" };

export interface EditingSession {
  document: SubtitleDocument;
  undoStack: SubtitleDocument[];
  redoStack: SubtitleDocument[];
}

const MAX_DOCUMENT_TEXT_UNITS = 10 * 1024 * 1024;

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

function throwIfInvalid(document: SubtitleDocument): void {
  const [error] = validateSubtitleDocument(document);
  if (error) throw new Error(error);
}

function cueById(document: SubtitleDocument, cueId: string): SubtitleCue {
  const cue = document.document.cues.find((candidate) => candidate.id === cueId);
  if (!cue) throw new Error("cue_not_found");
  return cue;
}

function selectedCueIds(document: SubtitleDocument, cueIds?: readonly string[]): Set<string> {
  if (!cueIds) return new Set(document.document.cues.map((cue) => cue.id));
  if (cueIds.length === 0 || new Set(cueIds).size !== cueIds.length) {
    throw new Error("cue_selection_invalid");
  }
  const selected = new Set(cueIds);
  for (const cueId of selected) cueById(document, cueId);
  return selected;
}

function renumber(cues: SubtitleCue[]): void {
  cues.forEach((cue, index) => {
    cue.ordinal = index + 1;
  });
}

function invalidateStructuralRoundTrip(document: SubtitleDocument): void {
  document.document.format.roundTrip = "fallback";
  if (document.document.format.detected === "vtt") {
    delete document.document.format.metadata.vttBlocks;
  }
  for (const cue of document.document.cues) {
    delete cue.formatData.srtIndex;
    delete cue.formatData.vttCueIdentifier;
  }
}

function replaceLiteral(value: string, find: string, replacement: string): string {
  let count = 0;
  let index = 0;
  while ((index = value.indexOf(find, index)) >= 0) {
    count += 1;
    index += find.length;
  }
  if (value.length + count * (replacement.length - find.length) > MAX_DOCUMENT_TEXT_UNITS) {
    throw new Error("subtitle_document_too_large");
  }
  return value.split(find).join(replacement);
}

function replaceInsensitive(value: string, find: string, replacement: string): string {
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(escaped, "giu");
  let count = 0;
  let replacedUnits = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(value))) {
    count += 1;
    replacedUnits += match[0].length;
  }
  if (value.length - replacedUnits + count * replacement.length > MAX_DOCUMENT_TEXT_UNITS) {
    throw new Error("subtitle_document_too_large");
  }
  return value.replace(expression, () => replacement);
}

export function calculateDocumentWarnings(
  document: SubtitleDocument,
  constraints: WarningConstraints = {},
): SubtitleDocument["document"]["warnings"] {
  const warnings: SubtitleDocument["document"]["warnings"] = [];
  const cues = document.document.cues;

  if (document.document.format.roundTrip === "fallback") {
    warnings.push({ code: "format_round_trip_fallback", cueIds: [] });
  }

  for (const cue of cues) {
    const durationMs = cue.endMs - cue.startMs;
    if (durationMs <= 0) warnings.push({ code: "non_positive_duration", cueIds: [cue.id] });
    if (constraints.minCueDurationMs !== undefined && durationMs < constraints.minCueDurationMs) {
      warnings.push({ code: "minimum_duration", cueIds: [cue.id] });
    }
    if (constraints.maxCueDurationMs !== undefined && durationMs > constraints.maxCueDurationMs) {
      warnings.push({ code: "maximum_duration", cueIds: [cue.id] });
    }
    const lines = cue.text.split("\n");
    if (
      constraints.maxCharsPerLine !== undefined &&
      lines.some((line) => [...line].length > constraints.maxCharsPerLine!)
    ) {
      warnings.push({ code: "characters_per_line", cueIds: [cue.id] });
    }
    if (constraints.maxLinesPerCue !== undefined && lines.length > constraints.maxLinesPerCue) {
      warnings.push({ code: "lines_per_cue", cueIds: [cue.id] });
    }
    if (constraints.maxReadingSpeed !== undefined && durationMs > 0) {
      const characters = [...cue.text].filter((character) => !/\s/u.test(character)).length;
      if (characters / (durationMs / 1000) > constraints.maxReadingSpeed) {
        warnings.push({ code: "reading_speed", cueIds: [cue.id] });
      }
    }
  }

  for (let index = 1; index < cues.length; index += 1) {
    const previous = cues[index - 1]!;
    const current = cues[index]!;
    if (current.startMs < previous.endMs) {
      warnings.push({ code: "overlap", cueIds: [previous.id, current.id] });
    } else if (current.startMs > previous.endMs) {
      warnings.push({ code: "gap", cueIds: [previous.id, current.id] });
    }
  }
  return warnings;
}

export function applyEditOperation(
  current: SubtitleDocument,
  operation: EditOperation,
): SubtitleDocument {
  throwIfInvalid(current);
  const next = clone(current);
  next.document.version += 1;
  const cues = next.document.cues;

  if (operation.type === "update_cue") {
    const cue = cueById(next, operation.cueId);
    if (Object.keys(operation.patch).length === 0) throw new Error("cue_patch_empty");
    if (operation.patch.text !== undefined) {
      if (operation.patch.text.length > MAX_DOCUMENT_TEXT_UNITS) {
        throw new Error("subtitle_document_too_large");
      }
      cue.text = operation.patch.text;
      cue.lineBreaks = lineBreaks(operation.patch.text);
    }
    if (operation.patch.startMs !== undefined) cue.startMs = operation.patch.startMs;
    if (operation.patch.endMs !== undefined) cue.endMs = operation.patch.endMs;
    if (operation.patch.speaker !== undefined) cue.speaker = operation.patch.speaker;
    if (operation.patch.style !== undefined) cue.style = operation.patch.style;
  } else if (operation.type === "split") {
    const index = cues.findIndex((cue) => cue.id === operation.cueId);
    if (index < 0) throw new Error("cue_not_found");
    if (!operation.newCueId || cues.some((cue) => cue.id === operation.newCueId)) {
      throw new Error("cue_id_duplicate");
    }
    const cue = cues[index]!;
    if (
      !Number.isSafeInteger(operation.textOffset) ||
      operation.textOffset < 1 ||
      operation.textOffset >= [...cue.text].length ||
      !Number.isSafeInteger(operation.splitAtMs) ||
      operation.splitAtMs <= cue.startMs ||
      operation.splitAtMs >= cue.endMs
    ) {
      throw new Error("cue_split_invalid");
    }
    const characters = [...cue.text];
    const firstText = characters
      .slice(0, operation.textOffset)
      .join("")
      .replace(/[ \t]$/u, "");
    const secondText = characters
      .slice(operation.textOffset)
      .join("")
      .replace(/^[ \t]/u, "");
    if (!firstText || !secondText) throw new Error("cue_split_invalid");
    const second = clone(cue);
    const firstTags = cue.tags.filter(
      (value) => firstText.includes(value) || !secondText.includes(value),
    );
    const secondTags = cue.tags.filter((value) => secondText.includes(value));
    const firstPlaceholders = cue.placeholders.filter(
      (value) => firstText.includes(value) || !secondText.includes(value),
    );
    const secondPlaceholders = cue.placeholders.filter((value) => secondText.includes(value));
    cue.endMs = operation.splitAtMs;
    cue.text = firstText;
    cue.lineBreaks = lineBreaks(firstText);
    cue.tags = firstTags;
    cue.placeholders = firstPlaceholders;
    second.id = operation.newCueId;
    second.startMs = operation.splitAtMs;
    second.text = secondText;
    second.lineBreaks = lineBreaks(secondText);
    second.tags = secondTags;
    second.placeholders = secondPlaceholders;
    second.formatData = {};
    cues.splice(index + 1, 0, second);
    renumber(cues);
    invalidateStructuralRoundTrip(next);
  } else if (operation.type === "merge") {
    const [firstId, secondId] = operation.cueIds;
    const firstIndex = cues.findIndex((cue) => cue.id === firstId);
    const secondIndex = cues.findIndex((cue) => cue.id === secondId);
    if (firstIndex < 0 || secondIndex < 0) throw new Error("cue_not_found");
    if (secondIndex !== firstIndex + 1) throw new Error("cue_merge_not_adjacent");
    const first = cues[firstIndex]!;
    const second = cues[secondIndex]!;
    if (first.speaker !== second.speaker || first.style !== second.style) {
      throw new Error("cue_merge_metadata_conflict");
    }
    first.endMs = Math.max(first.endMs, second.endMs);
    first.text = `${first.text}${operation.separator ?? "\n"}${second.text}`;
    first.lineBreaks = lineBreaks(first.text);
    first.tags = [...new Set([...first.tags, ...second.tags])];
    first.placeholders = [...new Set([...first.placeholders, ...second.placeholders])];
    cues.splice(secondIndex, 1);
    renumber(cues);
    invalidateStructuralRoundTrip(next);
  } else if (operation.type === "nudge_timing") {
    if (!Number.isSafeInteger(operation.deltaMs) || operation.deltaMs === 0) {
      throw new Error("timing_delta_invalid");
    }
    const selected = selectedCueIds(next, operation.cueIds);
    for (const cue of cues) {
      if (!selected.has(cue.id)) continue;
      cue.startMs += operation.deltaMs;
      cue.endMs += operation.deltaMs;
    }
  } else {
    if (!operation.find) throw new Error("find_text_empty");
    const selected = selectedCueIds(next, operation.cueIds);
    for (const cue of cues) {
      if (!selected.has(cue.id)) continue;
      cue.text =
        operation.caseSensitive === false
          ? replaceInsensitive(cue.text, operation.find, operation.replace)
          : replaceLiteral(cue.text, operation.find, operation.replace);
      cue.lineBreaks = lineBreaks(cue.text);
    }
  }

  if (
    next.document.cues.reduce((total, cue) => total + cue.text.length, 0) > MAX_DOCUMENT_TEXT_UNITS
  ) {
    throw new Error("subtitle_document_too_large");
  }
  throwIfInvalid(next);
  next.document.warnings = calculateDocumentWarnings(next);
  return next;
}

export function prepareRestore(
  current: SubtitleDocument,
  historical: SubtitleDocument,
): SubtitleDocument {
  throwIfInvalid(current);
  throwIfInvalid(historical);
  if (current.document.id !== historical.document.id) throw new Error("document_id_conflict");
  const restored = clone(historical);
  restored.document.version = current.document.version + 1;
  restored.document.warnings = calculateDocumentWarnings(restored);
  throwIfInvalid(restored);
  return restored;
}

export function createEditingSession(document: SubtitleDocument): EditingSession {
  throwIfInvalid(document);
  return { document: clone(document), undoStack: [], redoStack: [] };
}

export function applySessionCommand(
  session: EditingSession,
  command: SessionCommand,
): EditingSession {
  const next = clone(session);
  if (command.type === "undo") {
    const previous = next.undoStack.pop();
    if (!previous) throw new Error("nothing_to_undo");
    next.redoStack.push(next.document);
    next.document = previous;
    return next;
  }
  if (command.type === "redo") {
    const following = next.redoStack.pop();
    if (!following) throw new Error("nothing_to_redo");
    next.undoStack.push(next.document);
    next.document = following;
    return next;
  }
  next.undoStack.push(next.document);
  next.document = applyEditOperation(next.document, command);
  next.redoStack = [];
  return next;
}

export type SharedTimedDocument = SubtitleDocument | TimedDocumentV3;

function transcriptEditAdapter(document: TimedDocumentV3): SubtitleDocument {
  return {
    version: "v2",
    document: {
      id: document.document.id,
      version: document.document.version,
      sourceKind: "subtitle",
      sourceLanguage: document.document.sourceLanguage,
      targetLanguage: document.document.targetLanguage,
      format: {
        detected: "srt",
        declaredExtension: null,
        declaredMediaType: null,
        roundTrip: "preserve",
        metadata: {},
      },
      cues: structuredClone(document.document.cues),
      words: document.document.words.map((word) => ({
        id: word.id,
        startMs: word.startMs,
        endMs: word.endMs,
        text: word.text,
        ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
      })),
      warnings: [],
    },
  };
}

/** Shared v2/v3 edit boundary. Transcript edits never rewrite canonical words or source evidence. */
export function applyTimedDocumentEdit<T extends SharedTimedDocument>(
  current: T,
  operation: EditOperation,
): T {
  if (current.version === "v2") return applyEditOperation(current, operation) as T;
  if (current.document.sourceKind !== "transcript") throw new Error("source_kind_invalid");
  const edited = applyEditOperation(transcriptEditAdapter(current), operation);
  const next = structuredClone(current);
  next.document.version = edited.document.version;
  next.document.cues = edited.document.cues;
  next.document.warnings = edited.document.warnings.filter(
    (warning) => warning.code !== "format_round_trip_fallback",
  );
  return next;
}

export function prepareTimedDocumentRestore<T extends SharedTimedDocument>(
  current: T,
  historical: T,
): T {
  if (current.version !== historical.version) throw new Error("document_contract_conflict");
  if (current.document.id !== historical.document.id) throw new Error("document_id_conflict");
  if (current.version === "v2") return prepareRestore(current, historical as SubtitleDocument) as T;
  const restored = structuredClone(historical);
  restored.document.version = current.document.version + 1;
  return restored;
}
