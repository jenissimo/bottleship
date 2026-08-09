/**
 * Rich Text Format reader — RTF bytes → styled text runs.
 *
 * RTF is a byte format with a per-font code page: the same `\'e0` is `à` in a
 * cp1252 document and `а` in a cp1251 one, so decoding may only happen once the
 * enclosing `\ansicpg` / `\fcharset` is known. Text bytes are therefore buffered
 * raw and decoded at run boundaries rather than character by character, which is
 * also what makes a DBCS document (`\fcharset128` shift_jis) come out intact.
 *
 * Scope is "what a document shows": character formatting, paragraph breaks and
 * the colour table. Tables, pictures, fields and every `{\*\...}` destination are
 * skipped the way a reader that cannot render them must — silently and completely,
 * so their control words never leak into the text.
 */

/** One span of text sharing a single character format. */
export interface RtfRun {
    text: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    /** RTF `\fsN` — half-points. 24 (12pt) is the format's default. */
    fontSizeHalfPoints: number;
    /** 0xRRGGBB from `\cf` + `\colortbl`, or null for the default text colour. */
    color: number | null;
}

export interface RtfDocument {
    /** All run texts concatenated; `\par`/`\line` are '\n', `\tab` is '\t'. */
    text: string;
    runs: RtfRun[];
    /** Document code page (`\ansicpg`), or the 1252 default. */
    codePage: number;
}

export interface ParseRtfOptions {
    /**
     * Code-page decoder. The default uses `TextDecoder`, which covers the legacy
     * code pages in a BROWSER but not under every runtime — Bun rejects
     * `windows-1251` outright, and silently falling back to latin1 there would
     * turn Cyrillic into plausible-looking mojibake. A host with its own
     * code-page tables should pass them in.
     */
    decode?: (bytes: Uint8Array, codePage: number) => string;
}

const DEFAULT_CODE_PAGE = 1252;
const DEFAULT_FONT_SIZE = 24;

/** `\fcharsetN` → code page (RTF spec charset table). */
const CHARSET_CODE_PAGES = new Map<number, number>([
    [0, 1252], [2, 1252], [77, 10000], [128, 932], [129, 949], [130, 1361],
    [134, 936], [136, 950], [161, 1253], [162, 1254], [163, 1258], [177, 1255],
    [178, 1256], [186, 1257], [204, 1251], [222, 874], [238, 1250], [255, 437],
]);

/**
 * Code page → TextDecoder label. Anything absent falls back to latin1. cp437/cp850 are
 * deliberately absent: the encoding standard ships no table for either, and answering with
 * ibm866 would decode US/Latin-1 OEM high bytes as Cyrillic — mojibake the caller cannot
 * detect, which is worse than the latin1 fallback.
 */
const CODE_PAGE_LABELS = new Map<number, string>([
    [866, 'ibm866'], [874, 'windows-874'],
    [932, 'shift_jis'], [936, 'gbk'], [949, 'euc-kr'], [950, 'big5'],
    [1250, 'windows-1250'], [1251, 'windows-1251'], [1252, 'windows-1252'],
    [1253, 'windows-1253'], [1254, 'windows-1254'], [1255, 'windows-1255'],
    [1256, 'windows-1256'], [1257, 'windows-1257'], [1258, 'windows-1258'],
    [10000, 'macintosh'], [65001, 'utf-8'],
]);

/** Destinations whose contents are structure, not document text. */
const SKIPPED_DESTINATIONS = new Set([
    'stylesheet', 'info', 'pict', 'object', 'objdata', 'result', 'listtable',
    'listoverridetable', 'revtbl', 'filetbl', 'generator', 'themedata', 'datastore',
    'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
    'footnote', 'annotation', 'atnid', 'atnauthor', 'xe', 'tc', 'bkmkstart', 'bkmkend',
]);

const decoderCache = new Map<number, TextDecoder | null>();

function getDecoder(codePage: number): TextDecoder | null {
    if (decoderCache.has(codePage)) return decoderCache.get(codePage)!;
    const label = CODE_PAGE_LABELS.get(codePage);
    let decoder: TextDecoder | null = null;
    if (label) {
        try {
            decoder = new TextDecoder(label);
        } catch {
            decoder = null;
        }
    }
    decoderCache.set(codePage, decoder);
    return decoder;
}

function decodeWithTextDecoder(buf: Uint8Array, codePage: number): string {
    const decoder = getDecoder(codePage);
    if (decoder) return decoder.decode(buf);
    let out = '';
    for (const b of buf) out += String.fromCharCode(b);
    return out;
}

/** True when `bytes` opens with the RTF signature. */
export function isRtf(bytes: Uint8Array): boolean {
    if (bytes.length < 5) return false;
    return bytes[0] === 0x7b /* { */ && bytes[1] === 0x5c /* \ */
        && bytes[2] === 0x72 /* r */ && bytes[3] === 0x74 /* t */ && bytes[4] === 0x66 /* f */;
}

type Destination = 'body' | 'fonttbl' | 'colortbl' | 'skip';

interface GroupState {
    destination: Destination;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    fontSize: number;
    colorIndex: number;
    fontIndex: number;
    /** `\ucN` — how many fallback characters follow a `\uN`. */
    uc: number;
}

/**
 * Parse an RTF document. Never throws: malformed input yields whatever text was
 * recoverable, because the caller (a control asked to display a file it did not
 * write) has no better answer than showing what it could read.
 */
export function parseRtf(bytes: Uint8Array, options: ParseRtfOptions = {}): RtfDocument {
    const decode = options.decode ?? decodeWithTextDecoder;
    const runs: RtfRun[] = [];
    /** `\cf` is 1-based; the leading `;` of a `\colortbl` fills index 0 ("auto"). */
    const colorTable: Array<number | null> = [];
    const fontCharsets = new Map<number, number>();
    let docCodePage = DEFAULT_CODE_PAGE;

    let state: GroupState = {
        destination: 'body',
        bold: false, italic: false, underline: false,
        fontSize: DEFAULT_FONT_SIZE, colorIndex: 0, fontIndex: -1, uc: 1,
    };
    const stack: GroupState[] = [];

    // Bytes of the current run, undecoded until the code page or the format changes.
    let pendingBytes: number[] = [];
    let runText = '';
    let runStyle: GroupState = { ...state };
    /** Fallback characters still to be dropped after a `\uN` (see `\ucN`). */
    let unicodeSkip = 0;
    /** `\*` seen: the destination the NEXT control word opens is ignorable. */
    let ignorableNext = false;
    // Colour under construction while inside `\colortbl`.
    let colorR = 0, colorG = 0, colorB = 0, colorSet = false;

    const activeCodePage = (): number => {
        const charset = fontCharsets.get(state.fontIndex);
        if (charset === undefined) return docCodePage;
        return CHARSET_CODE_PAGES.get(charset) ?? docCodePage;
    };

    const flushBytes = (): void => {
        if (pendingBytes.length === 0) return;
        runText += decode(Uint8Array.from(pendingBytes), activeCodePage());
        pendingBytes = [];
    };

    const flushRun = (): void => {
        flushBytes();
        if (runText.length > 0) {
            runs.push({
                text: runText,
                bold: runStyle.bold,
                italic: runStyle.italic,
                underline: runStyle.underline,
                fontSizeHalfPoints: runStyle.fontSize,
                color: runStyle.colorIndex > 0 ? (colorTable[runStyle.colorIndex] ?? null) : null,
            });
            runText = '';
        }
        runStyle = { ...state };
    };

    const appendText = (s: string): void => {
        if (state.destination !== 'body') return;
        flushBytes();
        runText += s;
    };

    const appendByte = (b: number): void => {
        if (state.destination === 'colortbl') {
            if (b === 0x3b /* ; */) {
                colorTable.push(colorSet ? ((colorR << 16) | (colorG << 8) | colorB) : null);
                colorR = colorG = colorB = 0;
                colorSet = false;
            }
            return;
        }
        if (state.destination !== 'body') return;
        if (unicodeSkip > 0) { unicodeSkip--; return; }
        pendingBytes.push(b);
    };

    const applyControlWord = (name: string, value: number | null): void => {
        switch (name) {
            case 'fonttbl':
                state.destination = 'fonttbl';
                return;
            case 'colortbl':
                flushRun();
                state.destination = 'colortbl';
                colorR = colorG = colorB = 0;
                colorSet = false;
                return;
            case 'ansicpg':
                if (value !== null && value > 0) docCodePage = value;
                return;
            case 'mac': docCodePage = 10000; return;
            case 'pc': docCodePage = 437; return;
            case 'pca': docCodePage = 850; return;
            case 'uc':
                if (value !== null && value >= 0) state.uc = value;
                return;
            case 'f':
                // A font switch changes how the following bytes decode, so the buffered
                // ones must be decoded under the OLD font's code page first.
                if (value === null) return;
                if (state.destination !== 'fonttbl') flushBytes();
                state.fontIndex = value;
                return;
            case 'fcharset':
                if (value !== null && state.fontIndex >= 0) fontCharsets.set(state.fontIndex, value);
                return;
            case 'red': colorR = clampByte(value); colorSet = true; return;
            case 'green': colorG = clampByte(value); colorSet = true; return;
            case 'blue': colorB = clampByte(value); colorSet = true; return;
        }

        if (SKIPPED_DESTINATIONS.has(name)) {
            flushRun();
            state.destination = 'skip';
            return;
        }
        if (state.destination !== 'body') return;

        switch (name) {
            case 'b':
                flushRun(); state.bold = value !== 0; runStyle = { ...state }; return;
            case 'i':
                flushRun(); state.italic = value !== 0; runStyle = { ...state }; return;
            case 'ul':
                flushRun(); state.underline = value !== 0; runStyle = { ...state }; return;
            case 'ulnone':
                flushRun(); state.underline = false; runStyle = { ...state }; return;
            case 'fs':
                if (value === null || value <= 0) return;
                flushRun(); state.fontSize = value; runStyle = { ...state }; return;
            case 'cf':
                if (value === null) return;
                flushRun(); state.colorIndex = value; runStyle = { ...state }; return;
            case 'plain':
                flushRun();
                state.bold = state.italic = state.underline = false;
                state.fontSize = DEFAULT_FONT_SIZE;
                state.colorIndex = 0;
                runStyle = { ...state };
                return;
            case 'par': case 'sect': case 'page': case 'line': case 'row':
                appendText('\n'); return;
            case 'tab': case 'cell':
                appendText('\t'); return;
            case 'emdash': appendText('—'); return;
            case 'endash': appendText('–'); return;
            case 'lquote': appendText('‘'); return;
            case 'rquote': appendText('’'); return;
            case 'ldblquote': appendText('“'); return;
            case 'rdblquote': appendText('”'); return;
            case 'bullet': appendText('•'); return;
            case 'u': {
                if (value === null) return;
                appendText(String.fromCharCode((value < 0 ? value + 0x10000 : value) & 0xffff));
                unicodeSkip = state.uc;
                return;
            }
            default:
                return;
        }
    };

    let i = 0;
    const len = bytes.length;
    while (i < len) {
        const c = bytes[i];

        if (c === 0x7b /* { */) {
            flushRun();
            stack.push({ ...state });
            state = { ...state };
            unicodeSkip = 0;
            i++;
            continue;
        }
        if (c === 0x7d /* } */) {
            flushRun();
            const popped = stack.pop();
            if (popped) state = popped;
            runStyle = { ...state };
            unicodeSkip = 0;
            i++;
            continue;
        }
        if (c !== 0x5c /* \ */) {
            // Bare CR/LF carry no meaning in RTF; the paragraph break is `\par`.
            if (c !== 0x0d && c !== 0x0a) appendByte(c);
            i++;
            continue;
        }

        i++;
        if (i >= len) break;
        const lead = bytes[i];
        const isLetter = (lead >= 0x61 && lead <= 0x7a) || (lead >= 0x41 && lead <= 0x5a);

        if (!isLetter) {
            i++;
            switch (lead) {
                case 0x27: { // \'hh — a raw byte in the active code page
                    let value = 0;
                    let digits = 0;
                    while (digits < 2 && i < len) {
                        const h = hexDigit(bytes[i]);
                        if (h < 0) break;
                        value = (value << 4) | h;
                        i++;
                        digits++;
                    }
                    if (digits > 0) appendByte(value);
                    break;
                }
                case 0x5c: case 0x7b: case 0x7d: // \\ \{ \}
                    appendByte(lead);
                    break;
                case 0x2a: // \* — the destination opened next is ignorable
                    ignorableNext = true;
                    break;
                case 0x7e: appendText(' '); break; // non-breaking space
                case 0x5f: appendText('-'); break;      // non-breaking hyphen
                case 0x0d: case 0x0a: appendText('\n'); break; // \<CR>/\<LF> = \par
                default:
                    break; // \- (optional hyphen), \: and \| render as nothing
            }
            continue;
        }

        let wordEnd = i;
        while (wordEnd < len) {
            const w = bytes[wordEnd];
            if ((w >= 0x61 && w <= 0x7a) || (w >= 0x41 && w <= 0x5a)) wordEnd++;
            else break;
        }
        let word = '';
        for (let k = i; k < wordEnd; k++) word += String.fromCharCode(bytes[k]);
        i = wordEnd;

        let param: number | null = null;
        const negative = i < len && bytes[i] === 0x2d /* - */;
        if (negative) i++;
        if (i < len && bytes[i] >= 0x30 && bytes[i] <= 0x39) {
            let v = 0;
            while (i < len && bytes[i] >= 0x30 && bytes[i] <= 0x39) {
                v = v * 10 + (bytes[i] - 0x30);
                i++;
            }
            param = negative ? -v : v;
        }
        // A single space after a control word is its delimiter, not text.
        if (i < len && bytes[i] === 0x20) i++;

        const openedIgnorable = ignorableNext;
        ignorableNext = false;

        // `\binN` is followed by N raw bytes that are not RTF at all.
        if (word === 'bin' && param !== null && param > 0) {
            i = Math.min(len, i + param);
            continue;
        }

        if (openedIgnorable && word !== 'fonttbl' && word !== 'colortbl') {
            flushRun();
            state.destination = 'skip';
            continue;
        }

        applyControlWord(word, param);
    }

    flushRun();

    let text = '';
    for (const run of runs) text += run.text;
    return { text, runs, codePage: docCodePage };
}

function clampByte(value: number | null): number {
    if (value === null) return 0;
    return value < 0 ? 0 : value > 255 ? 255 : value;
}

function hexDigit(b: number): number {
    if (b >= 0x30 && b <= 0x39) return b - 0x30;
    if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
    if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
    return -1;
}
