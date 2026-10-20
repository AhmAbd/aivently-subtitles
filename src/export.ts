import { calculateDocumentWarnings, type WarningConstraints } from "./edit.js";
import { validateSubtitleDocument, type SubtitleDocument, type SubtitleFormat } from "./model.js";

export type SubtitleOutputFormat = "srt" | "vtt" | "ass" | "txt" | "json" | "original";

export interface CopySubtitleOptions {
  form: "plain" | "selected" | "timestamped";
  cueIds?: readonly string[];
}

export interface ExportConstraints extends WarningConstraints {
  speakerFormat?: string;
}

export interface SubtitleExportResult {
  content: string | null;
  format: SubtitleOutputFormat;
  warnings: SubtitleDocument["document"]["warnings"];
  fallbackFormats?: readonly ["srt", "vtt"];
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function timeFromMs(ms: number, separator: "." | ","): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(millis, 3)}`;
}

function assTimeFromMs(ms: number): string {
  const centiseconds = Math.floor(ms / 10);
  const totalSeconds = Math.floor(centiseconds / 100);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(centiseconds % 100, 2)}`;
}

function validateForExport(document: SubtitleDocument): void {
  if (validateSubtitleDocument(document).length > 0) throw new Error("subtitle_invalid");
}

function cueTextRepresentable(text: string): boolean {
  return (
    text.length > 0 &&
    !text.includes("\r") &&
    !text.includes("\n\n") &&
    !text.startsWith("\n") &&
    !text.endsWith("\n")
  );
}

function timedTextRepresentable(
  document: SubtitleDocument,
  format: "srt" | "vtt",
  text: ReturnType<typeof speakerFormatter>,
): boolean {
  if (!document.document.cues.every((cue) => cueTextRepresentable(text(cue)))) return false;
  if (format !== "vtt" || document.document.format.detected !== "vtt") return true;
  const metadata = document.document.format.metadata;
  const singleLine = (value: unknown): boolean =>
    typeof value === "string" && !/[\r\n]/u.test(value);
  if (metadata.vttHeader !== undefined && !singleLine(metadata.vttHeader)) return false;
  if (
    metadata.vttHeaderLines !== undefined &&
    (!Array.isArray(metadata.vttHeaderLines) || !metadata.vttHeaderLines.every(singleLine))
  ) {
    return false;
  }
  if (
    metadata.vttBlocks !== undefined &&
    (!Array.isArray(metadata.vttBlocks) ||
      !metadata.vttBlocks.every((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const lines = (value as Record<string, unknown>).lines;
        return Array.isArray(lines) && lines.length > 0 && lines.every(singleLine);
      }))
  ) {
    return false;
  }
  return document.document.cues.every(
    (cue) =>
      (cue.formatData.vttCueIdentifier === undefined ||
        (singleLine(cue.formatData.vttCueIdentifier) && cue.formatData.vttCueIdentifier !== "")) &&
      (cue.formatData.vttSettings === undefined || singleLine(cue.formatData.vttSettings)),
  );
}

function speakerFormatter(
  template?: string,
): (cue: SubtitleDocument["document"]["cues"][number]) => string {
  if (template === undefined) return (cue) => cue.text;
  if (
    template.length < 1 ||
    template.length > 100 ||
    template.includes("\r") ||
    template.includes("\n\n") ||
    !template.includes("{text}") ||
    template.replaceAll("{speaker}", "").replaceAll("{text}", "").includes("{")
  ) {
    throw new Error("speaker_format_invalid");
  }
  return (cue) =>
    cue.speaker
      ? template
          .replaceAll("{speaker}", () => cue.speaker ?? "")
          .replaceAll("{text}", () => cue.text)
      : cue.text;
}

function renderSrt(document: SubtitleDocument, text: ReturnType<typeof speakerFormatter>): string {
  return `${document.document.cues
    .map(
      (cue) =>
        `${typeof cue.formatData.srtIndex === "string" && /^\d+$/u.test(cue.formatData.srtIndex) ? cue.formatData.srtIndex : cue.ordinal}\n${timeFromMs(cue.startMs, ",")} --> ${timeFromMs(cue.endMs, ",")}\n${text(cue)}`,
    )
    .join("\n\n")}\n`;
}

function vttMetadata(document: SubtitleDocument): {
  header: string;
  headerLines: string[];
  blocks: Array<{ beforeOrdinal: number; lines: string[] }>;
} {
  const metadata =
    document.document.format.detected === "vtt" ? document.document.format.metadata : {};
  const header =
    typeof metadata.vttHeader === "string" && /^WEBVTT(?:\s|$)/u.test(metadata.vttHeader)
      ? metadata.vttHeader
      : "WEBVTT";
  const headerLines = Array.isArray(metadata.vttHeaderLines)
    ? metadata.vttHeaderLines.filter((line): line is string => typeof line === "string")
    : [];
  const storedBlocks = Array.isArray(metadata.vttBlocks) ? metadata.vttBlocks : [];
  const blocks = storedBlocks.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const block = value as Record<string, unknown>;
    if (!Number.isSafeInteger(block.beforeOrdinal) || Number(block.beforeOrdinal) < 1) return [];
    if (!Array.isArray(block.lines) || !block.lines.every((line) => typeof line === "string")) {
      return [];
    }
    return [{ beforeOrdinal: Number(block.beforeOrdinal), lines: block.lines as string[] }];
  });
  return { header, headerLines, blocks };
}

function renderVtt(document: SubtitleDocument, text: ReturnType<typeof speakerFormatter>): string {
  const { header, headerLines, blocks } = vttMetadata(document);
  const outputBlocks: string[] = [[header, ...headerLines].join("\n")];
  for (const cue of document.document.cues) {
    for (const block of blocks.filter((candidate) => candidate.beforeOrdinal === cue.ordinal)) {
      outputBlocks.push(block.lines.join("\n"));
    }
    const settings =
      document.document.format.detected === "vtt" &&
      typeof cue.formatData.vttSettings === "string" &&
      cue.formatData.vttSettings.trim()
        ? ` ${cue.formatData.vttSettings.trim()}`
        : "";
    const identifier =
      document.document.format.detected === "vtt" &&
      typeof cue.formatData.vttCueIdentifier === "string"
        ? `${cue.formatData.vttCueIdentifier}\n`
        : "";
    outputBlocks.push(
      `${identifier}${timeFromMs(cue.startMs, ".")} --> ${timeFromMs(cue.endMs, ".")}${settings}\n${text(cue)}`,
    );
  }
  for (const block of blocks.filter(
    (candidate) => candidate.beforeOrdinal > document.document.cues.length,
  )) {
    outputBlocks.push(block.lines.join("\n"));
  }
  return `${outputBlocks.join("\n\n")}\n`;
}

function assField(value: string | null | undefined, fallback = ""): string {
  const normalized = (value ?? fallback).replaceAll(/[\r\n,]/gu, " ").trim();
  return normalized || fallback;
}

function assLineArray(value: unknown, kind: "script" | "style"): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every(
      (line) =>
        typeof line === "string" &&
        !/[\r\n]/u.test(line) &&
        !/^\s*\[[^\]]+\]\s*$/u.test(line) &&
        (kind === "script" || /^\s*(?:format|style)\s*:/iu.test(line)),
    )
  ) {
    return null;
  }
  return value;
}

function assEventFormat(document: SubtitleDocument): string[] {
  const value = document.document.format.metadata.assEventFormat;
  if (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.every(
      (field) => typeof field === "string" && /^[a-z][a-z0-9 ]{0,31}$/iu.test(field.trim()),
    )
  ) {
    const normalized = value.map((field) => String(field).trim().toLowerCase());
    if (
      normalized.at(-1) === "text" &&
      normalized.includes("start") &&
      normalized.includes("end") &&
      new Set(normalized).size === normalized.length
    ) {
      return value.map((field) => String(field).trim());
    }
  }
  return [
    "Layer",
    "Start",
    "End",
    "Style",
    "Name",
    "MarginL",
    "MarginR",
    "MarginV",
    "Effect",
    "Text",
  ];
}

function assCueEventFields(
  cue: SubtitleDocument["document"]["cues"][number],
): Record<string, string> {
  const value = cue.formatData.assEventFields;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !/[\r\n,]/u.test(entry[1]),
    ),
  );
}

function renderAss(document: SubtitleDocument, text: ReturnType<typeof speakerFormatter>): string {
  const metadata = document.document.format.metadata;
  const scriptInfoLines = assLineArray(metadata.assScriptInfoLines, "script") ?? [
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
  ];
  const storedStyleLines = assLineArray(metadata.assStyleLines, "style");
  const styles = [
    "Default",
    ...new Set(
      document.document.cues
        .map((cue) => assField(cue.style))
        .filter((style) => style && style !== "Default"),
    ),
  ];
  const styleSection = metadata.assStyleSection === "V4 Styles" ? "V4 Styles" : "V4+ Styles";
  const styleLines =
    storedStyleLines && storedStyleLines.length > 0
      ? storedStyleLines
      : [
          "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
          ...styles.map(
            (style) =>
              `Style: ${style},Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1`,
          ),
        ];
  const eventFormat = assEventFormat(document);
  const header = [
    "[Script Info]",
    ...scriptInfoLines,
    "",
    `[${styleSection}]`,
    ...styleLines,
    "",
    "[Events]",
    `Format: ${eventFormat.join(", ")}`,
  ];
  const cues = document.document.cues.map((cue) => {
    const cueText = text(cue).replaceAll("\n", "\\N");
    const stored = assCueEventFields(cue);
    const fields = eventFormat.map((field) => {
      const normalized = field.toLowerCase();
      if (normalized === "start") return assTimeFromMs(cue.startMs);
      if (normalized === "end") return assTimeFromMs(cue.endMs);
      if (normalized === "style") return assField(cue.style, "Default");
      if (normalized === "name") return assField(cue.speaker);
      if (normalized === "text") return cueText;
      if (normalized === "layer" || normalized === "marked") {
        return assField(stored[normalized], "0");
      }
      if (normalized.startsWith("margin")) return assField(stored[normalized], "0");
      return assField(stored[normalized]);
    });
    return `Dialogue: ${fields.join(",")}`;
  });
  return `${[...header, ...cues].join("\n")}\n`;
}

function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderSbv(document: SubtitleDocument): string {
  return `${document.document.cues
    .map((cue) => `${timeFromMs(cue.startMs, ".")},${timeFromMs(cue.endMs, ".")}\n${cue.text}`)
    .join("\n\n")}\n`;
}

function renderLrc(document: SubtitleDocument): string {
  const tags = Array.isArray(document.document.format.metadata.lrcTags)
    ? document.document.format.metadata.lrcTags.filter(
        (value): value is string => typeof value === "string" && !/[\r\n\]]/u.test(value),
      )
    : [];
  const cues = document.document.cues.map((cue) => {
    const totalMinutes = Math.floor(cue.startMs / 60_000);
    const seconds = Math.floor((cue.startMs % 60_000) / 1000);
    return `[${pad(totalMinutes, 2)}:${pad(seconds, 2)}.${pad(cue.startMs % 1000, 3)}]${cue.text}`;
  });
  return `${[...tags.map((tag) => `[${tag}]`), ...cues].join("\n")}\n`;
}

function microDvdFrameRate(document: SubtitleDocument): number | null {
  const value = document.document.format.metadata.microDvdFrameRate;
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 120
    ? value
    : null;
}

function renderMicroDvd(document: SubtitleDocument): string {
  const frameRate = microDvdFrameRate(document);
  if (!frameRate) throw new Error("subtitle_format_unrepresentable");
  const cues = document.document.cues.map((cue) => {
    const storedStart = cue.formatData.microDvdStartFrame;
    const storedEnd = cue.formatData.microDvdEndFrame;
    const startFrame =
      typeof storedStart === "number" &&
      Math.round((storedStart * 1000) / frameRate) === cue.startMs
        ? storedStart
        : Math.round((cue.startMs * frameRate) / 1000);
    const endFrame =
      typeof storedEnd === "number" && Math.round((storedEnd * 1000) / frameRate) === cue.endMs
        ? storedEnd
        : Math.round((cue.endMs * frameRate) / 1000);
    return `{${startFrame}}{${endFrame}}${cue.text.replaceAll("\n", "|")}`;
  });
  return `{1}{1}${frameRate.toFixed(3)}\n${cues.join("\n")}\n`;
}

function renderTtml(document: SubtitleDocument): string {
  const cues = document.document.cues.map((cue) => {
    const style = cue.style ? ` style="${xmlText(cue.style)}"` : "";
    return `<p begin="${timeFromMs(cue.startMs, ".")}" end="${timeFromMs(cue.endMs, ".")}"${style}>${xmlText(cue.text).replaceAll("\n", "<br/>")}</p>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml"><body><div>${cues.join("")}</div></body></tt>\n`;
}

function renderSami(document: SubtitleDocument): string {
  const events = document.document.cues.flatMap((cue) => {
    const className =
      typeof cue.formatData.samiClass === "string" &&
      /^[a-z0-9_-]{1,64}$/iu.test(cue.formatData.samiClass)
        ? ` Class=${cue.formatData.samiClass}`
        : "";
    return [
      {
        time: cue.startMs,
        text: `<P${className}>${xmlText(cue.text).replaceAll("\n", "<br>")}</P>`,
      },
      { time: cue.endMs, text: `<P${className}>&nbsp;</P>` },
    ];
  });
  events.sort(
    (left, right) =>
      left.time - right.time ||
      Number(right.text.includes("&nbsp;")) - Number(left.text.includes("&nbsp;")),
  );
  return `<SAMI><BODY>\n${events.map((event) => `<SYNC Start=${event.time}>${event.text}`).join("\n")}\n</BODY></SAMI>\n`;
}

function renderMpl2(document: SubtitleDocument): string {
  return `${document.document.cues
    .map((cue) => `[${cue.startMs / 100}][${cue.endMs / 100}]${cue.text.replaceAll("\n", "|")}`)
    .join("\n")}\n`;
}

function renderTmp(document: SubtitleDocument): string {
  return `${document.document.cues
    .map((cue) => `${timeFromMs(cue.startMs, ".").slice(0, 8)}:${cue.text.replaceAll("\n", "|")}`)
    .join("\n")}\n`;
}

function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function renderCsv(document: SubtitleDocument): string {
  return `Start,End,Text,Speaker,Style\n${document.document.cues
    .map((cue) =>
      [
        timeFromMs(cue.startMs, "."),
        timeFromMs(cue.endMs, "."),
        csvField(cue.text),
        csvField(cue.speaker ?? ""),
        csvField(cue.style ?? ""),
      ].join(","),
    )
    .join("\n")}\n`;
}

function renderNativeOriginal(document: SubtitleDocument): string {
  const format = document.document.format.detected;
  if (format === "srt") return renderSrt(document, speakerFormatter());
  if (format === "vtt") return renderVtt(document, speakerFormatter());
  if (format === "ass") return renderAss(document, speakerFormatter());
  if (format === "sbv") return renderSbv(document);
  if (format === "lrc") return renderLrc(document);
  if (format === "sub") return renderMicroDvd(document);
  if (format === "ttml") return renderTtml(document);
  if (format === "sami") return renderSami(document);
  if (format === "mpl2") return renderMpl2(document);
  if (format === "tmp") return renderTmp(document);
  if (format === "csv") return renderCsv(document);
  if (format === "plain") return `${document.document.cues.map((cue) => cue.text).join("\n")}\n`;
  throw new Error("subtitle_format_unrepresentable");
}

function publicMetadata(document: SubtitleDocument): Record<string, unknown> {
  if (document.document.format.detected === "ass") {
    const metadata = document.document.format.metadata;
    return {
      assKind: metadata.assKind,
      assScriptInfoLines: assLineArray(metadata.assScriptInfoLines, "script") ?? [],
      assStyleSection:
        metadata.assStyleSection === "V4 Styles" || metadata.assStyleSection === "V4+ Styles"
          ? metadata.assStyleSection
          : null,
      assStyleLines: assLineArray(metadata.assStyleLines, "style") ?? [],
      assEventFormat: assEventFormat(document),
    };
  }
  if (document.document.format.detected !== "vtt") return {};
  const { header, headerLines, blocks } = vttMetadata(document);
  return { vttHeader: header, vttHeaderLines: headerLines, vttBlocks: blocks };
}

function publicCueFormatData(
  document: SubtitleDocument,
  cue: SubtitleDocument["document"]["cues"][number],
): Record<string, unknown> {
  if (document.document.format.detected === "srt") {
    return typeof cue.formatData.srtIndex === "string" && /^\d+$/u.test(cue.formatData.srtIndex)
      ? { srtIndex: cue.formatData.srtIndex }
      : {};
  }
  if (document.document.format.detected === "vtt") {
    return {
      ...(typeof cue.formatData.vttCueIdentifier === "string"
        ? { vttCueIdentifier: cue.formatData.vttCueIdentifier }
        : {}),
      ...(typeof cue.formatData.vttSettings === "string"
        ? { vttSettings: cue.formatData.vttSettings }
        : {}),
    };
  }
  if (document.document.format.detected === "ass") {
    const overrides = Array.isArray(cue.formatData.assOverrides)
      ? cue.formatData.assOverrides.filter(
          (value) =>
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Number.isSafeInteger((value as Record<string, unknown>).offset) &&
            typeof (value as Record<string, unknown>).value === "string",
        )
      : [];
    return { assEventFields: assCueEventFields(cue), assOverrides: overrides };
  }
  return {};
}

function jsonDocument(document: SubtitleDocument): Record<string, unknown> {
  return {
    version: "v2",
    document: {
      id: document.document.id,
      version: document.document.version,
      sourceKind: "subtitle",
      sourceLanguage: document.document.sourceLanguage,
      targetLanguage: document.document.targetLanguage,
      format: {
        detected: document.document.format.detected,
        declaredExtension: document.document.format.declaredExtension,
        declaredMediaType: document.document.format.declaredMediaType,
        roundTrip: document.document.format.roundTrip,
        metadata: publicMetadata(document),
      },
      cues: document.document.cues.map((cue) => ({
        id: cue.id,
        ordinal: cue.ordinal,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
        ...(cue.speaker === undefined ? {} : { speaker: cue.speaker }),
        ...(cue.style === undefined ? {} : { style: cue.style }),
        lineBreaks: [...cue.lineBreaks],
        tags: [...cue.tags],
        placeholders: [...cue.placeholders],
        formatData: publicCueFormatData(document, cue),
      })),
      words: document.document.words.map((word) => ({ ...word })),
      warnings: document.document.warnings.map((warning) => ({
        code: warning.code,
        cueIds: [...warning.cueIds],
      })),
    },
  };
}

export function exportSubtitle(document: SubtitleDocument, format: "srt" | "vtt"): string {
  validateForExport(document);
  const text = speakerFormatter();
  if (!timedTextRepresentable(document, format, text)) {
    throw new Error("subtitle_format_unrepresentable");
  }
  return format === "srt" ? renderSrt(document, text) : renderVtt(document, text);
}

export function copySubtitle(document: SubtitleDocument, options: CopySubtitleOptions): string {
  validateForExport(document);
  let cues = document.document.cues;
  if (options.form === "selected") {
    if (!options.cueIds || options.cueIds.length === 0) {
      throw new Error("subtitle_copy_selection_empty");
    }
    if (new Set(options.cueIds).size !== options.cueIds.length) {
      throw new Error("subtitle_copy_selection_invalid");
    }
    const requested = new Set(options.cueIds);
    if (options.cueIds.some((cueId) => !cues.some((cue) => cue.id === cueId))) {
      throw new Error("subtitle_copy_selection_invalid");
    }
    cues = cues.filter((cue) => requested.has(cue.id));
  }
  if (options.form === "timestamped") {
    return `${cues
      .map(
        (cue) => `${timeFromMs(cue.startMs, ".")} --> ${timeFromMs(cue.endMs, ".")}\n${cue.text}`,
      )
      .join("\n\n")}\n`;
  }
  return `${cues.map((cue) => cue.text).join("\n")}\n`;
}

function metadataRepresentable(document: SubtitleDocument): boolean {
  const metadataKeys = Object.keys(document.document.format.metadata);
  if (document.document.format.detected === "srt") {
    return (
      metadataKeys.length === 0 &&
      document.document.cues.every((cue) => {
        const keys = Object.keys(cue.formatData);
        return (
          keys.every((key) => key === "srtIndex") &&
          (cue.formatData.srtIndex === undefined ||
            (typeof cue.formatData.srtIndex === "string" && /^\d+$/u.test(cue.formatData.srtIndex)))
        );
      })
    );
  }
  if (document.document.format.detected !== "vtt") {
    const format = document.document.format.detected;
    if (format === "ass") {
      const metadata = document.document.format.metadata;
      if (
        !metadataKeys.every((key) =>
          [
            "assKind",
            "assScriptInfoLines",
            "assStyleSection",
            "assStyleLines",
            "assEventFormat",
          ].includes(key),
        ) ||
        (metadata.assKind !== "ass" && metadata.assKind !== "ssa") ||
        assLineArray(metadata.assScriptInfoLines, "script") === null ||
        assLineArray(metadata.assStyleLines, "style") === null ||
        (metadata.assStyleSection !== null &&
          metadata.assStyleSection !== "V4 Styles" &&
          metadata.assStyleSection !== "V4+ Styles") ||
        !Array.isArray(metadata.assEventFormat)
      ) {
        return false;
      }
      const rawEventFormat = metadata.assEventFormat;
      const eventFormat = assEventFormat(document);
      if (
        eventFormat.length !== rawEventFormat.length ||
        eventFormat.some((field, index) => field !== rawEventFormat[index])
      ) {
        return false;
      }
      const eventKeys = new Set(eventFormat.map((field) => field.toLowerCase()));
      return document.document.cues.every((cue) => {
        const keys = Object.keys(cue.formatData);
        const fields = cue.formatData.assEventFields;
        const overrides = cue.formatData.assOverrides;
        return (
          keys.every((key) => key === "assEventFields" || key === "assOverrides") &&
          fields !== null &&
          typeof fields === "object" &&
          !Array.isArray(fields) &&
          Object.entries(fields).every(
            ([key, value]) =>
              eventKeys.has(key) &&
              !["start", "end", "style", "name", "text"].includes(key) &&
              typeof value === "string" &&
              !/[\r\n,]/u.test(value),
          ) &&
          Array.isArray(overrides) &&
          overrides.every(
            (value) =>
              value !== null &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              Number.isSafeInteger((value as Record<string, unknown>).offset) &&
              Number((value as Record<string, unknown>).offset) >= 0 &&
              Number((value as Record<string, unknown>).offset) <= cue.text.length &&
              typeof (value as Record<string, unknown>).value === "string" &&
              /^\{\\[^}\r\n]*\}$/u.test(String((value as Record<string, unknown>).value)),
          )
        );
      });
    }
    const permittedMetadata: Partial<Record<SubtitleFormat, readonly string[]>> = {
      sbv: [],
      lrc: ["lrcTags"],
      sub: ["microDvdFrameRate"],
      ttml: [],
      sami: [],
      mpl2: [],
      tmp: [],
      csv: ["csvHeader"],
      plain: ["syntheticTiming"],
    };
    const permitted = permittedMetadata[format];
    if (!permitted || !metadataKeys.every((key) => permitted.includes(key))) return false;
    if (
      format === "lrc" &&
      (!Array.isArray(document.document.format.metadata.lrcTags) ||
        !document.document.format.metadata.lrcTags.every(
          (value) => typeof value === "string" && !/[\r\n\]]/u.test(value),
        ))
    ) {
      return false;
    }
    if (format === "sub" && microDvdFrameRate(document) === null) return false;
    return true;
  }
  if (!metadataKeys.every((key) => ["vttHeader", "vttHeaderLines", "vttBlocks"].includes(key))) {
    return false;
  }
  const metadata = document.document.format.metadata;
  if (
    (metadata.vttHeader !== undefined &&
      (typeof metadata.vttHeader !== "string" || !/^WEBVTT(?:\s|$)/u.test(metadata.vttHeader))) ||
    (metadata.vttHeaderLines !== undefined &&
      (!Array.isArray(metadata.vttHeaderLines) ||
        !metadata.vttHeaderLines.every((line) => typeof line === "string"))) ||
    (metadata.vttBlocks !== undefined &&
      (!Array.isArray(metadata.vttBlocks) ||
        !metadata.vttBlocks.every(
          (value) =>
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Number.isSafeInteger((value as Record<string, unknown>).beforeOrdinal) &&
            Number((value as Record<string, unknown>).beforeOrdinal) >= 1 &&
            Array.isArray((value as Record<string, unknown>).lines) &&
            ((value as Record<string, unknown>).lines as unknown[]).every(
              (line) => typeof line === "string",
            ),
        )))
  ) {
    return false;
  }
  return document.document.cues.every((cue) => {
    const keys = Object.keys(cue.formatData);
    return (
      keys.every((key) => key === "vttCueIdentifier" || key === "vttSettings") &&
      (cue.formatData.vttCueIdentifier === undefined ||
        (typeof cue.formatData.vttCueIdentifier === "string" &&
          !/[\r\n]/u.test(cue.formatData.vttCueIdentifier))) &&
      (cue.formatData.vttSettings === undefined ||
        (typeof cue.formatData.vttSettings === "string" &&
          !/[\r\n]/u.test(cue.formatData.vttSettings)))
    );
  });
}

function derivedEndIsRepresentable(document: SubtitleDocument): boolean {
  return document.document.cues.every((cue, index) => {
    const next = document.document.cues[index + 1];
    return cue.endMs === (next ? next.startMs : cue.startMs + 2000);
  });
}

function nativeOriginalRepresentable(document: SubtitleDocument): boolean {
  const format = document.document.format.detected;
  const cues = document.document.cues;
  if (!cues.every((cue) => cueTextRepresentable(cue.text))) return false;
  if (format === "srt" || format === "vtt") {
    return (
      cues.every((cue) => cue.speaker == null && cue.style == null) &&
      timedTextRepresentable(document, format, speakerFormatter())
    );
  }
  if (format === "ass") {
    return cues.every(
      (cue) =>
        cue.startMs % 10 === 0 &&
        cue.endMs % 10 === 0 &&
        !/[{}]|\\[Nnh]/u.test(cue.text) &&
        (!Array.isArray(cue.formatData.assOverrides) || cue.formatData.assOverrides.length === 0),
    );
  }
  if (format === "sbv") return cues.every((cue) => cue.speaker == null && cue.style == null);
  if (format === "lrc") {
    return (
      derivedEndIsRepresentable(document) &&
      cues.every((cue) => cue.speaker == null && cue.style == null && !cue.text.includes("\n"))
    );
  }
  if (format === "sub") {
    const frameRate = microDvdFrameRate(document);
    return (
      frameRate !== null &&
      cues.every(
        (cue) =>
          cue.speaker == null &&
          cue.style == null &&
          !cue.text.includes("|") &&
          Math.round((Math.round((cue.startMs * frameRate) / 1000) * 1000) / frameRate) ===
            cue.startMs &&
          Math.round((Math.round((cue.endMs * frameRate) / 1000) * 1000) / frameRate) === cue.endMs,
      )
    );
  }
  if (format === "ttml") return cues.every((cue) => cue.speaker == null);
  if (format === "sami") return cues.every((cue) => cue.speaker == null && cue.style == null);
  if (format === "mpl2") {
    return cues.every(
      (cue) =>
        cue.startMs % 100 === 0 &&
        cue.endMs % 100 === 0 &&
        cue.speaker == null &&
        cue.style == null &&
        !cue.text.includes("|"),
    );
  }
  if (format === "tmp") {
    return (
      derivedEndIsRepresentable(document) &&
      cues.every(
        (cue) =>
          cue.startMs % 1000 === 0 &&
          cue.speaker == null &&
          cue.style == null &&
          !cue.text.includes("|"),
      )
    );
  }
  if (format === "csv") return true;
  if (format === "plain") {
    return cues.every(
      (cue, index) =>
        cue.startMs === index * 2000 &&
        cue.endMs === (index + 1) * 2000 &&
        cue.speaker == null &&
        cue.style == null &&
        !cue.text.includes("\n"),
    );
  }
  return false;
}

export function canPreserveOriginal(document: SubtitleDocument): boolean {
  return (
    document.document.format.roundTrip === "preserve" &&
    exportSupportedFormats().includes(document.document.format.detected) &&
    metadataRepresentable(document) &&
    nativeOriginalRepresentable(document)
  );
}

export function renderSubtitleExport(
  document: SubtitleDocument,
  options: { format: SubtitleOutputFormat; constraints?: ExportConstraints },
): SubtitleExportResult {
  const errors = validateSubtitleDocument(document);
  const text = speakerFormatter(options.constraints?.speakerFormat);
  const warningDocument = structuredClone(document);
  for (const cue of warningDocument.document.cues) cue.text = text(cue);
  const warnings = calculateDocumentWarnings(warningDocument, options.constraints);
  if (errors.length > 0) {
    if (errors.every((error) => error === "cue_timing_invalid")) {
      return { content: null, format: options.format, warnings };
    }
    throw new Error("subtitle_invalid");
  }
  if (options.format === "original") {
    if (!canPreserveOriginal(document)) {
      return {
        content: null,
        format: "original",
        fallbackFormats: ["srt", "vtt"],
        warnings: [...warnings, { code: "original_format_unsupported", cueIds: [] }],
      };
    }
    if (["srt", "vtt", "ass"].includes(document.document.format.detected)) {
      return renderSubtitleExport(document, {
        format: document.document.format.detected as "srt" | "vtt" | "ass",
        constraints: options.constraints,
      });
    }
    return { content: renderNativeOriginal(document), format: "original", warnings };
  }

  if (
    ["srt", "vtt", "txt"].includes(options.format) &&
    document.document.cues.some(
      (cue) =>
        cue.style != null ||
        (cue.speaker != null && options.constraints?.speakerFormat === undefined),
    )
  ) {
    warnings.push({ code: "format_metadata_omitted", cueIds: [] });
  }
  if (
    (options.format === "srt" || options.format === "vtt") &&
    !timedTextRepresentable(document, options.format, text)
  ) {
    return {
      content: null,
      format: options.format,
      warnings: [...warnings, { code: "format_text_unrepresentable", cueIds: [] }],
    };
  }

  let content: string;
  if (options.format === "srt") content = renderSrt(document, text);
  else if (options.format === "vtt") content = renderVtt(document, text);
  else if (options.format === "ass") {
    if (document.document.cues.some((cue) => /[{}]|\\[Nnh]/u.test(text(cue)))) {
      return {
        content: null,
        format: "ass",
        warnings: [...warnings, { code: "ass_text_unrepresentable", cueIds: [] }],
      };
    }
    content = renderAss(document, text);
    if (document.document.cues.some((cue) => cue.startMs % 10 !== 0 || cue.endMs % 10 !== 0)) {
      warnings.push({ code: "ass_timestamp_precision_loss", cueIds: [] });
    }
  } else if (options.format === "txt") {
    content = `${document.document.cues.map((cue) => text(cue)).join("\n")}\n`;
  } else content = `${JSON.stringify(jsonDocument(document), null, 2)}\n`;
  return { content, format: options.format, warnings };
}

export function exportSupportedFormats(): readonly SubtitleFormat[] {
  return ["srt", "vtt", "ass", "sbv", "lrc", "sub", "ttml", "sami", "mpl2", "tmp", "csv", "plain"];
}

export function exportOutputFormats(): readonly Exclude<SubtitleOutputFormat, "original">[] {
  return ["srt", "vtt", "ass", "txt", "json"];
}
