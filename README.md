# aivently-subtitles

A subtitle toolkit for TypeScript and JavaScript. It parses, validates,
converts, shifts, checks, merges and exports subtitle files. It has no runtime
dependencies, and it works in the browser, Node, Deno, Bun and edge runtimes.

This is the parser behind the [free subtitle tools on Aivently](https://aivently.com/en/tools/)
and the [Aivently AI subtitle translator](https://aivently.com/en/translate-subtitles/).

## Formats

| Format | Read | Write |
| --- | :---: | :---: |
| SRT (SubRip) | yes | yes |
| WebVTT | yes | yes |
| ASS / SSA | yes | yes |
| YouTube SBV | yes | as original |
| MicroDVD SUB | yes | as original |
| TTML / DFXP | yes | as original |
| SAMI (SMI) | yes | as original |
| LRC | yes | as original |
| MPL2 | yes | as original |
| TMP | yes | as original |
| CSV (`Start,End,Text`) | yes | as original |
| SCC (Scenarist) | `convertScc` | — |
| EBU-STL | `convertEbuStl` | — |

All formats can also be written as plain text (`txt`) or as a structured JSON
document (`json`).

## Install

```sh
npm install aivently-subtitles
```

## Quick start

```ts
import {
  loadSubtitleText,
  convertSubtitle,
  shiftSubtitle,
  checkSubtitle,
  dualSubtitles,
} from "aivently-subtitles";

const { document } = loadSubtitleText(srtText, "episode.srt"); // detects the format from content

convertSubtitle(document, "vtt"); // SRT → WebVTT
convertSubtitle(document, "txt"); // dialogue only

// Fix subtitles that are 2.5 s late, or convert 23.976 fps timing to 25 fps
const synced = shiftSubtitle(document, { offsetMs: -2500, fromFps: 23.976, toFps: 25 });

// Line length, lines per cue, reading speed (CPS), duration and overlaps
const report = checkSubtitle(document);
// → { cueCount, durationMs, findings: [{ code: "reading_speed", ordinals: [12] }], counts }

// Two languages in one SRT, paired by timing
const dual = dualSubtitles(englishDocument, spanishDocument);
```

## Lower-level API

```ts
import { detectSubtitleFormat, parseSubtitle, renderSubtitleExport } from "aivently-subtitles";

const detection = detectSubtitleFormat({ filename: "movie.ass", content });
// → { format: "ass", status: "supported" | "mismatch" | "gated" | "unsupported", declaredFormat }

const document = parseSubtitle(content, { id: "movie", format: "ass" });

const result = renderSubtitleExport(document, {
  format: "original", // or "srt" | "vtt" | "ass" | "txt" | "json"
  constraints: { maxCharsPerLine: 42, maxLinesPerCue: 2, maxReadingSpeed: 17 },
});
// → { content, format, warnings, fallbackFormats? }
```

Format details are kept where the target format can carry them:

- ASS styles, event fields and override tags;
- WebVTT headers, `NOTE`/`STYLE`/`REGION` blocks, cue identifiers and settings;
- the original SRT cue numbers.

When a round trip would lose information, `renderSubtitleExport` returns
`content: null` together with a warning, so nothing is dropped silently.

Edit helpers (`applyEditOperation` and `createEditingSession` with undo and
redo) support cue updates, splits, merges, timing nudges, and find and
replace.

## Safety limits

The parsers enforce these limits:

- 50,000 source lines;
- 64 KiB per line;
- 10,000 cues;
- bounded tag and override counts.

They reject `DOCTYPE` and `ENTITY` in XML formats. Malformed input throws an
`Error` with a stable snake_case code, such as `subtitle_timing_invalid`.

## Free online tools

You can use these without installing anything. They run in your browser, and
your file is never uploaded.

- [Subtitle converter](https://aivently.com/en/tools/subtitle-converter/) (SRT, VTT, ASS, SUB, SBV, TTML…)
- [SRT to text](https://aivently.com/en/tools/srt-to-text/)
- [Subtitle sync / time shifter](https://aivently.com/en/tools/subtitle-sync/)
- [SRT checker](https://aivently.com/en/tools/subtitle-checker/)
- [SRT merger](https://aivently.com/en/tools/srt-merger/)
- [Dual subtitles maker](https://aivently.com/en/tools/dual-subtitles/)
- [Sample SRT, VTT and ASS files](https://aivently.com/en/tools/sample-srt-files/)

To translate subtitles with AI and keep the timing intact, see
[Aivently](https://aivently.com/en/translate-subtitles/).

## Development

```sh
npm install
npm test
npm run build
```

All test fixtures are synthetic.

## License

MIT © Aivently
