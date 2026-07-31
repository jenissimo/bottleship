/**
 * HBINK (struct BINK) field offsets — versioned ABI.
 *
 * The guest reads this struct directly from the header it compiled against, and RAD
 * moved fields between Bink SDK releases. Offsets verified by disassembling the
 * BinkNextFrame frame-wrap compare, BinkGetSummary's field copies and BinkGetRects
 * in real binkw32.dll builds:
 *
 *   0.5a  W,H,Frames,FrameNum,           Rate,RateDiv,...  rects@0x30 num@0xB0
 *   0.8i  W,H,W,H,   Frames,FrameNum,Last,Rate,RateDiv,... rects@0x3C num@0xBC
 *   1.0f  W,H,Frames,FrameNum,Last,      Rate,RateDiv,...  rects@0x34 num@0xB4
 *   1.5a  as 1.0f
 *
 * 0.8i duplicates Width/Height into 0x08/0x0C (BinkGetSummary sources them there) and
 * so pushes everything from Frames on by 8. Writing one fixed layout for every title
 * mis-places Frames/FrameNum by 8 bytes on 0.8x, and a game's "video finished" test
 * (FrameNum == Frames-1) then never fires — the playback loop spins forever.
 */

export interface BinkStructLayout {
    /** SDK generation label for diagnostics. */
    id: string;
    width: number;
    height: number;
    /** Second Width/Height pair (Bink 0.8x only); null when the layout has none. */
    widthAlt: number | null;
    heightAlt: number | null;
    frames: number;
    frameNum: number;
    /** LastFrameNum — absent in 0.5x. */
    lastFrameNum: number | null;
    frameRate: number;
    frameRateDiv: number;
    readError: number;
    openFlags: number;
    binkType: number;
    size: number;
    frameSize: number;
    sndSize: number;
    /** BINKRECT FrameRects[8] — {Left, Top, Width, Height}, 16 bytes each. */
    frameRects: number;
    numRects: number;
}

/** Header fields, in declaration order — every release is the same set, shifted. */
type BinkField = Exclude<keyof BinkStructLayout, 'id' | 'frameRects' | 'numRects'>;

/** Build a layout from the ordered field list; FrameRects follows the last header field. */
function layout(id: string, fields: readonly BinkField[]): BinkStructLayout {
    const out = {
        id, widthAlt: null, heightAlt: null, lastFrameNum: null,
    } as unknown as BinkStructLayout;
    fields.forEach((name, i) => { (out as Record<BinkField, number | null>)[name] = i * 4; });
    out.frameRects = fields.length * 4;
    out.numRects = out.frameRects + 8 * 16;
    return out;
}

const COMMON_TAIL = ['readError', 'openFlags', 'binkType', 'size', 'frameSize', 'sndSize'] as const;

/** Bink 0.5x — no LastFrameNum. */
export const BINK_LAYOUT_V05 = layout('0.5x', [
    'width', 'height', 'frames', 'frameNum', 'frameRate', 'frameRateDiv', ...COMMON_TAIL,
]);

/** Bink 0.8x — Width/Height duplicated at 0x08/0x0C. */
export const BINK_LAYOUT_V08 = layout('0.8x', [
    'width', 'height', 'widthAlt', 'heightAlt',
    'frames', 'frameNum', 'lastFrameNum', 'frameRate', 'frameRateDiv', ...COMMON_TAIL,
]);

/** Bink 1.x — the layout published in bink.h. */
export const BINK_LAYOUT_V1 = layout('1.x', [
    'width', 'height', 'frames', 'frameNum', 'lastFrameNum', 'frameRate', 'frameRateDiv', ...COMMON_TAIL,
]);

/** Last resort when the shipped DLL carries no readable version at all (1.x is the long
 *  tail of releases). Picking it is a GUESS — callers must say so out loud. */
export const BINK_LAYOUT_DEFAULT = BINK_LAYOUT_V1;

/** `0.5a` / `1.0f`, and the comma-separated form RAD-era resources are written in
 *  ("0, 8, 0, 0"). A dotted-only pattern silently drops the latter onto the default. */
const BINK_VERSION_RE = /^\s*(\d+)\s*[.,]\s*(\d+)/;

/** Layout for a major/minor pair, whatever it was read from. */
export function binkLayoutFor(major: number, minor: number): BinkStructLayout {
    if (major >= 1) return BINK_LAYOUT_V1;
    return minor >= 8 ? BINK_LAYOUT_V08 : BINK_LAYOUT_V05;
}

/**
 * Pick the layout for a binkw32.dll FileVersion ("0.5a", "0.8i", "1.0f", "1.5a",
 * "1.9x", "0, 8, 0, 0"). Returns null when the version is unreadable — the caller
 * must fall back LOUDLY rather than have a guess look like a resolution.
 */
export function selectBinkLayout(fileVersion: string | null | undefined): BinkStructLayout | null {
    const m = BINK_VERSION_RE.exec(fileVersion ?? '');
    if (!m) return null;
    return binkLayoutFor(Number(m[1]), Number(m[2]));
}
