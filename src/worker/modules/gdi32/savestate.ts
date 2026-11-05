import { System } from '../../core/system';
import { savestateParticipants, stateKeys, type FieldPolicy } from '../../savestate/participant';
import { CaptureRefusal, objectCodecs } from '../../savestate/object-codecs';
import type { SaveValue } from '../../savestate/value-codec';
import {
    DC_STATE_FIELDS, GDI_OBJECT_FIELDS, SAVED_DC_FIELDS, type GdiContextState, type SavedCanvas, type SavedDc,
} from './context';
import { captureDcRegionState, restoreDcRegionState, type DcMapping, type DcRegionState } from './painting-dc-state';
import { captureMetafileCounter, restoreMetafileCounter } from './painting-misc';
import { capturePaintingModuleState, restorePaintingModuleState, type PaintingModuleState } from './painting';
import { captureFontGeneration, restoreFontGeneration, runtimeFontCount } from './font-resource';
import type { DcClipRegion } from './dc-clip';

export interface UserImageRecord {
    type: 'ICON' | 'CURSOR' | 'BITMAP';
    name?: number | string;
    width: number;
    height: number;
    pixels: Uint8Array | Uint8ClampedArray | null;
    loading: boolean;
    xHotspot?: number;
    yHotspot?: number;
    systemCursorId?: number;
    isTopDown?: boolean;
    bitCount?: number;
    dibStride?: number;
    dibTopDown?: boolean;
    dibBits?: Uint8Array;
    palette?: unknown;
    compatibleBitmap?: boolean;
    compatibleEmpty?: boolean;
    bitsPtr?: number;
    bitsSize?: number;
    bmBpp?: number;
    dibBpp?: number;
    dibMasks?: number[];
    dibPalette?: unknown;
    dibBitsPtr?: number;
    shared?: boolean;
}

export const USER_IMAGE_FIELDS = {
    type: 'save', name: 'save', width: 'save', height: 'save', pixels: 'save', loading: 'save', xHotspot: 'save',
    yHotspot: 'save', systemCursorId: 'save', isTopDown: 'save', bitCount: 'save', dibStride: 'save', dibTopDown: 'save',
    dibBits: 'save', palette: 'save', compatibleBitmap: 'save', compatibleEmpty: 'save', bitsPtr: 'save', bitsSize: 'save',
    bmBpp: 'save', dibBpp: 'save', dibMasks: 'save', dibPalette: 'save', dibBitsPtr: 'save', shared: 'save',
} as const satisfies Record<keyof UserImageRecord, FieldPolicy>;

// @transient(constant set)
const IMAGE_TYPES = new Set(['ICON', 'CURSOR', 'BITMAP']);

type Clamped = { $clamped: Uint8Array };

function isUserImage(o: unknown): o is UserImageRecord {
    return o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype
        && IMAGE_TYPES.has(String((o as { type?: unknown }).type));
}

export function captureUserImage(o: UserImageRecord): Record<string, SaveValue> {
    if (o.loading) throw new CaptureRefusal(`gdi32: a ${o.type.toLowerCase()} is still loading`);
    const out: Record<string, SaveValue> = {};
    for (const [key, value] of Object.entries(o)) {
        if (!(key in USER_IMAGE_FIELDS)) throw new CaptureRefusal(`gdi32: ${o.type.toLowerCase()} field ${key} has no savestate policy`);
        if (value === undefined) continue;
        out[key] = value instanceof Uint8ClampedArray
            ? { $clamped: new Uint8Array(value) } as unknown as SaveValue
            : ArrayBuffer.isView(value) ? (value as Uint8Array).slice() : structuredClone(value) as SaveValue;
    }
    return out;
}

export function restoreUserImage(d: Record<string, SaveValue>): UserImageRecord {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(d)) {
        if (!(key in USER_IMAGE_FIELDS)) throw new Error(`gdi32: saved image field ${key} has no policy in this build`);
        const clamped = value as unknown as Partial<Clamped> | null;
        out[key] = clamped && typeof clamped === 'object' && clamped.$clamped instanceof Uint8Array
            ? new Uint8ClampedArray(clamped.$clamped)
            : ArrayBuffer.isView(value) ? (value as Uint8Array).slice() : structuredClone(value);
    }
    return out as unknown as UserImageRecord;
}

export interface Gdi32State {
    context: GdiContextState;
    regions: DcRegionState;
    nextMetafile: number;
    painting: PaintingModuleState;
    fontGeneration: number;
}

const keys = <T>(k: Record<keyof T, true>) => stateKeys<T>(k);

export const GDI32_SCHEMA = {
    state: keys<Gdi32State>({ context: true, regions: true, nextMetafile: true, painting: true, fontGeneration: true }),
    context: keys<GdiContextState>({
        objects: true, nextHdc: true, nextHgdiobj: true, dcs: true, currentPos: true, fontCache: true, handleRefs: true,
        bitmapDCs: true, bitmapVersions: true, dcBitmapSync: true, stockObjects: true, systemPaletteUse: true,
        overlay: true, overlayHasContent: true, clientBackings: true,
    }),
    object: GDI_OBJECT_FIELDS,
    dc: keys<SavedDc>({ hdc: true, state: true, canvas: true, bitmapHandle: true }),
    dcState: DC_STATE_FIELDS,
    savedDc: SAVED_DC_FIELDS,
    canvas: keys<SavedCanvas>({ width: true, height: true, pixels: true }),
    region: keys<DcClipRegion>({ rects: true, x1: true, y1: true, x2: true, y2: true }),
    regions: keys<DcRegionState>({ regions: true, nextRgnHandle: true, mappings: true }),
    mapping: keys<DcMapping>({
        mapMode: true, graphicsMode: true, wndOrgX: true, wndOrgY: true, vportOrgX: true, vportOrgY: true,
        wndExtX: true, wndExtY: true, vportExtX: true, vportExtY: true,
    }),
    painting: keys<PaintingModuleState>({ pixelFormatByHdc: true, lastGetDIBitsBuffer: true }),
    userImage: USER_IMAGE_FIELDS,
} as const;

export function captureGdi32State(): Gdi32State {
    if (runtimeFontCount() > 0) throw new Error('gdi32: fonts added at run time are not part of a v1 savestate');
    return {
        context: System.getInstance().gdiContext.captureState(),
        regions: captureDcRegionState(),
        nextMetafile: captureMetafileCounter(),
        painting: capturePaintingModuleState(),
        fontGeneration: captureFontGeneration(),
    };
}

export function restoreGdi32State(s: Gdi32State): void {
    restoreDcRegionState(s.regions);
    restoreMetafileCounter(s.nextMetafile);
    restorePaintingModuleState(s.painting);
    restoreFontGeneration(s.fontGeneration);
    System.getInstance().gdiContext.restoreState(s.context);
}

export function registerGdi32Participants(): void {
    objectCodecs.add<UserImageRecord>({
        tag: 'user-image',
        matches: isUserImage,
        capture: (o) => captureUserImage(o),
        restore: (d: Record<string, SaveValue>) => restoreUserImage(d),
    });
    savestateParticipants.add({
        id: 'gdi32', version: 1, order: 45, covers: ['gdi32'], schema: GDI32_SCHEMA as unknown as SaveValue,
        capture: () => {
            try {
                return captureGdi32State() as unknown as SaveValue;
            } catch (e) {
                if (e instanceof CaptureRefusal) throw e;
                throw new CaptureRefusal(e instanceof Error ? e.message : String(e));
            }
        },
        restore: (s) => restoreGdi32State(s as unknown as Gdi32State),
    });
}
