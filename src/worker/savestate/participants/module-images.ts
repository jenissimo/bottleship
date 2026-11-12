import { System, type ImplicitTlsEntry } from '../../core/system';
import type { LoadedPEModule, ModuleRegistry } from '../../core/module-registry';
import type { InlineStubState, PELoader } from '../../core/pe-loader';
import { boundHleModules, markHleModuleLoaded } from '../../core/hle-module-images';
import { pickDefined, stateKeys, type CaptureContext, type FieldPolicy, type Participant } from '../participant';
import { sha256HexSync } from '../sha256';
import type { SaveValue } from '../value-codec';

export const MODULE_IMAGE_FIELDS = {
    name: 'save', path: 'save', baseAddress: 'save', size: 'save', fileSize: 'save', entryPoint: 'save',
    initialized: 'save', sections: 'save', contentHash: 'save', imageBytes: 'save',
    exports: 'derive', ordinalExports: 'derive', isRealDll: 'derive', isExecutable: 'derive', unsaved: 'transient',
} as const satisfies Record<keyof LoadedPEModule, FieldPolicy>;

export type ModuleImageState = Pick<LoadedPEModule, 'name' | 'path' | 'baseAddress' | 'size' | 'entryPoint' | 'initialized'>
    & Partial<Pick<LoadedPEModule, 'fileSize' | 'sections' | 'contentHash'>> & { blob?: string };

export interface ModuleImagesState {
    images: ModuleImageState[];
    nextDllBase: number;
    freeDllRanges: Array<[number, number]>;
    implicitTls: ImplicitTlsEntry[];
    hleBound: string[];
    inlineStubs: InlineStubState;
}

export const MODULE_IMAGES_SCHEMA = {
    state: stateKeys<ModuleImagesState>({ images: true, nextDllBase: true, freeDllRanges: true, implicitTls: true, hleBound: true, inlineStubs: true }),
    image: MODULE_IMAGE_FIELDS,
    tls: stateKeys<ImplicitTlsEntry>({ tlsIndex: true, templateStart: true, templateSize: true, zeroFillSize: true, moduleName: true }),
    inlineStubs: stateKeys<InlineStubState>({ heap: true, crt: true, caseFold: true, locale: true, mbwc: true, mbwcDeclined: true, math: true }),
};

export type ImageLoader = Pick<PELoader, 'readImageFile' | 'parseExportTable' | 'captureInlineStubs' | 'restoreInlineStubs'>;
export type BlobReader = (hash: string) => Uint8Array;

const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;

export function captureModuleImages(registry: ModuleRegistry, loader: ImageLoader, ctx: Pick<CaptureContext, 'blob'>): ModuleImagesState {
    const images = registry.getAllModules().map((m): ModuleImageState => {
        if (m.unsaved) throw new Error(`module images: ${m.name} (${hex(m.baseAddress)}) was loaded at run time and ${m.unsaved}`);
        const { imageBytes, ...image } = pickDefined(m, MODULE_IMAGE_FIELDS);
        return imageBytes ? { ...image, blob: ctx.blob(imageBytes) } : image;
    });
    return {
        images, ...registry.captureLayout(),
        implicitTls: System.getInstance().implicitTlsEntries.map(e => ({ ...e })),
        hleBound: boundHleModules(),
        inlineStubs: loader.captureInlineStubs(),
    };
}

export async function verifyModuleImages(state: ModuleImagesState, registry: ModuleRegistry, loader: ImageLoader, blob: BlobReader): Promise<Map<number, Uint8Array>> {
    const files = new Map<number, Uint8Array>();
    const here = registry.getAllModules();
    const saved = new Set(state.images.map(i => i.baseAddress));
    for (const m of here) {
        if (!saved.has(m.baseAddress)) throw new Error(`module images: this session loads ${m.path} at ${hex(m.baseAddress)}, the snapshot does not`);
    }
    for (const image of state.images) {
        const have = registry.getByBase(image.baseAddress);
        if (have) {
            if (have.name !== image.name || have.path !== image.path || have.size !== image.size) {
                throw new Error(`module images: ${hex(image.baseAddress)} holds ${have.path} here, the snapshot has ${image.path}`);
            }
            continue;
        }
        if (!image.contentHash) throw new Error(`module images: ${image.path} is loaded at start in the snapshot, not in this session`);
        const end = image.baseAddress + image.size;
        const blocker = here.find(m => m.name === image.name || (m.baseAddress < end && image.baseAddress < m.baseAddress + m.size));
        if (blocker) throw new Error(`module images: the base ${hex(image.baseAddress)} of ${image.path} is taken by ${blocker.path} at ${hex(blocker.baseAddress)}`);
        const bytes = image.blob !== undefined ? blob(image.blob) : await loader.readImageFile(image.path);
        if (!bytes || bytes.length === 0) throw new Error(`module images: ${image.path} is missing`);
        if (bytes.length !== image.fileSize || sha256HexSync(bytes) !== image.contentHash) {
            throw new Error(image.blob !== undefined
                ? `module images: the stored copy of ${image.path} is not the file that was loaded`
                : `module images: ${image.path} changed since the snapshot was taken`);
        }
        files.set(image.baseAddress, bytes);
    }
    return files;
}

export function restoreModuleImages(state: ModuleImagesState, files: ReadonlyMap<number, Uint8Array>, registry: ModuleRegistry, loader: ImageLoader): void {
    for (const image of state.images) {
        if (registry.getByBase(image.baseAddress)) continue;
        const bytes = files.get(image.baseAddress);
        if (!bytes) throw new Error(`module images: ${image.path} was not verified`);
        const { exports, ordinals } = loader.parseExportTable(bytes, image.baseAddress);
        const module: LoadedPEModule = { ...pickDefined(image as LoadedPEModule, MODULE_IMAGE_FIELDS), exports, ordinalExports: ordinals, isRealDll: true };
        if (image.blob !== undefined) module.imageBytes = bytes;
        registry.register(module);
    }
    loader.restoreInlineStubs(state.inlineStubs);
    registry.restoreLayout(state.nextDllBase, state.freeDllRanges);
    System.getInstance().implicitTlsEntries = state.implicitTls.map(e => ({ ...e }));
    for (const name of state.hleBound) markHleModuleLoaded(name, false);
}

export function moduleImagesHooks(host: () => { registry: ModuleRegistry; loader: ImageLoader }): Required<Pick<Participant, 'capture' | 'verify' | 'restore'>> {
    let verified: { state: SaveValue; files: Map<number, Uint8Array> } | null = null;
    const verify = async (s: SaveValue, blob: BlobReader) => {
        const { registry, loader } = host();
        verified = { state: s, files: await verifyModuleImages(s as unknown as ModuleImagesState, registry, loader, blob) };
        return verified.files;
    };
    return {
        capture: (ctx) => captureModuleImages(host().registry, host().loader, ctx) as unknown as SaveValue,
        verify: async (s, blob) => { await verify(s, blob); },
        restore: async (s, ctx) => {
            const files = verified?.state === s ? verified.files : await verify(s, h => ctx.blob(h));
            verified = null;
            const { registry, loader } = host();
            restoreModuleImages(s as unknown as ModuleImagesState, files, registry, loader);
        },
    };
}
