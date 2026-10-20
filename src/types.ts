/* Timed document shapes shared by the parser, editor and exporters. */

export interface TimedDocumentV2 {
  version: "v2";
  document: {
    id: string;
    version: number;
    sourceKind: "subtitle";
    sourceLanguage: string | null;
    targetLanguage: string | null;
    format: {
      detected:
        | "srt"
        | "vtt"
        | "ass"
        | "sbv"
        | "lrc"
        | "sub"
        | "ttml"
        | "sami"
        | "mpl2"
        | "tmp"
        | "csv"
        | "scc"
        | "ebu-stl"
        | "plain";
      declaredExtension: string | null;
      declaredMediaType: string | null;
      roundTrip: "preserve" | "fallback";
      metadata: {
        [k: string]: any;
      };
    };
    cues: {
      id: string;
      ordinal: number;
      startMs: number;
      endMs: number;
      text: string;
      speaker?: string | null;
      style?: string | null;
      lineBreaks: number[];
      tags: string[];
      placeholders: string[];
      formatData: {
        [k: string]: any;
      };
    }[];
    words: {
      id: string;
      startMs: number;
      endMs: number;
      text: string;
      confidence?: number;
    }[];
    warnings: {
      code: string;
      cueIds: string[];
    }[];
  };
}

export interface TimedDocumentV3 {
  version: "v3";
  document: {
    id: string;
    version: number;
    sourceKind: "subtitle" | "transcript";
    sourceLanguage: string | null;
    targetLanguage: string | null;
    source: {
      authorityId: string;
      digest: string;
      profileVersion: string;
      metadata: {
        [k: string]: any;
      };
    };
    cues: {
      id: string;
      ordinal: number;
      startMs: number;
      endMs: number;
      text: string;
      speaker?: string | null;
      style?: string | null;
      lineBreaks: number[];
      tags: string[];
      placeholders: string[];
      formatData: {
        [k: string]: any;
      };
    }[];
    words: {
      id: string;
      ordinal: number;
      startMs: number;
      endMs: number;
      text: string;
      confidence?: number;
      speaker?: string | null;
      providerSpeaker?: string | null;
    }[];
    warnings: {
      code: string;
      cueIds: string[];
    }[];
  };
}
