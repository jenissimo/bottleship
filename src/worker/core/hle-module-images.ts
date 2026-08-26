/**
 * Materializes the synthetic PE image behind every HLE'd DLL's HMODULE, and owns the
 * name -> base mapping the rest of the system asks for.
 *
 * The images live in a pinned arena at the top of ROM (emulator-config
 * MEM_HLE_IMAGE_BASE). Each module's slot index is fixed in hle-system-catalog for the
 * named system DLLs; modules known only to the APIRegistry take the slots after them in
 * sorted order, which is deterministic per build.
 *
 * Materialization is eager and synchronous — it must complete before any guest
 * instruction runs, because a handle handed out before its image exists is the exact bug
 * this replaces.
 */

import { Logger, LogCategory } from "./logger";
import { HLE_IMAGE_SLOT_SIZE, MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE } from "./cpu/emulator-config";
import {
    HLE_IMAGE_FIRST_FREE_SLOT, HLE_IMAGE_SLOT, HLE_IMAGE_SLOT_COUNT,
    hleImageBaseForSlot, hleModuleMayHaveImage,
} from "./hle-system-catalog";
import { resolveThunkedDllAlias, normalizeDllBaseName } from "./dll-aliases";
import { APIRegistry } from "./api-registry";
import { buildHleModuleImage, hleModuleImageSize, type HleImageExport } from "./hle-module-image";
import { writeGuestCode } from "./memory/guest-code";
import { Mem } from "./memory/mem-accessor";
import { calculateStackCleanup } from "../api/types";

/** name -> slot, for every module that has one this process. Rebuilt on reset. */
let slotByName = new Map<string, number>();
/** name -> its image's export name -> absolute address. */
let exportsByName = new Map<string, Map<string, number>>();
/** The same map keyed by lowercased export name — import binding and GetProcAddress
 *  both look up case-insensitively. */
let exportsByLowerName = new Map<string, Map<string, number>>();
let ordinalsByName = new Map<string, Map<number, number>>();
let owner: unknown = null;
let ownerGeneration = -1;
/**
 * The modules this process actually LOADED, as opposed to the ones that merely have a
 * slot. Materialization is eager over every HLE'd DLL, so the arena holds images no real
 * process would contain — a 2001 game gets an MSVCR90.DLL image it never linked. Code
 * that answers a module WALK (VirtualQuery over the address space, then ask each base for
 * its name) must consult this, or it invents loaded modules: SmartHeap's shw32.dll walks
 * exactly like that, concludes the app links a foreign MSVC runtime, and refuses to start.
 * Populated by the name -> base handouts, which is what "the process asked for it" means.
 */
let loadedNames = new Set<string>();

/** Canonical module key: what LoadLibrary("DDRAW.DLL") and the slot table agree on. */
export function canonicalHleModuleName(dllName: string): string {
    return resolveThunkedDllAlias(normalizeDllBaseName(dllName));
}

/**
 * HMODULE for an HLE'd DLL, or undefined when we do not provide it (blocked by
 * disabledDlls, native-video mode, or a forced-native package). Callers must treat
 * undefined as "not ours" and fall through to the real load — never substitute a base.
 */
export function hleImageBase(dllName: string): number | undefined {
    const slot = slotByName.get(canonicalHleModuleName(dllName));
    return slot === undefined ? undefined : hleImageBaseForSlot(slot);
}

/**
 * Slots are keyed by the name they were planned under, which for an aliased flavour
 * (msvcr90 -> msvcrt) is NOT the canonical name — msvcr90 owns a slot of its own. Both
 * spellings must therefore be tracked, or marking "msvcrt" loaded would silently vouch
 * for every CRT flavour's image.
 */
function slotKeys(dllName: string): string[] {
    const raw = normalizeDllBaseName(dllName);
    const canonical = canonicalHleModuleName(dllName);
    return raw === canonical ? [canonical] : [raw, canonical];
}

/**
 * Record an HLE'd DLL as loaded: its imports were bound into a PE image, or the guest
 * asked for its handle by name. Deliberately NOT inside hleImageBase — our own warmup
 * loops resolve every known module's base, and marking there would vouch for all of them.
 */
export function markHleModuleLoaded(dllName: string): void {
    for (const key of slotKeys(dllName)) if (slotByName.has(key)) loadedNames.add(key);
}

/** Has this process loaded the module, or does it only have an image? See loadedNames. */
export function isHleModuleLoaded(dllName: string): boolean {
    const raw = normalizeDllBaseName(dllName);
    return loadedNames.has(slotByName.has(raw) ? raw : canonicalHleModuleName(dllName));
}

/** Reverse of hleImageBase, for logging and handle->name resolution. */
export function hleModuleNameByBase(base: number): string | undefined {
    const b = base >>> 0;
    if (b < MEM_HLE_IMAGE_BASE || b >= MEM_HLE_IMAGE_BASE + MEM_HLE_IMAGE_SIZE) return undefined;
    const slot = Math.floor((b - MEM_HLE_IMAGE_BASE) / HLE_IMAGE_SLOT_SIZE);
    if (hleImageBaseForSlot(slot) !== b) return undefined;
    for (const [name, s] of slotByName) if (s === slot) return name;
    return undefined;
}

/** Export addresses inside a materialized image (empty map when not materialized). */
export function hleImageExports(dllName: string): Map<string, number> {
    return exportsByName.get(canonicalHleModuleName(dllName)) ?? new Map();
}

/**
 * The in-image body of one export, keyed case-insensitively, or undefined when the
 * module has no image or the export was not stubbable.
 *
 * This is the address Windows puts in an importer's IAT and hands back from
 * GetProcAddress — one address per export. The PE loader binds through here so those
 * two cannot disagree: an IAT-hooking wrapper finds its slot by comparing the IAT
 * against the GetProcAddress result, and a second address for the same export makes
 * every such hook silently install nothing.
 */
export function hleImageExportAddress(dllName: string, exportName: string): number | undefined {
    return exportsByLowerName.get(canonicalHleModuleName(dllName))?.get(exportName.toLowerCase());
}

export function hleImageOrdinalExports(dllName: string): Map<number, number> {
    return ordinalsByName.get(canonicalHleModuleName(dllName)) ?? new Map();
}

/** Every module that got an image this process, in slot order. */
export function materializedHleModules(): Array<{ name: string; base: number; size: number }> {
    return [...slotByName.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([name, slot]) => ({ name, base: hleImageBaseForSlot(slot), size: HLE_IMAGE_SLOT_SIZE }));
}

/** HLE images the process has actually loaded, in loader order (slot order). */
export function loadedHleModules(): Array<{ name: string; base: number; size: number }> {
    return materializedHleModules().filter(({ name }) => isHleModuleLoaded(name));
}

/**
 * Assign slots and publish the images. Idempotent per (process, resetGeneration) — the
 * same guard shape kernel32's module caches use, since Process.reset() reuses the object
 * while zeroing ROM and regenerating every thunk.
 */
export function materializeHleModuleImages(process: any): void {
    if (owner === process && ownerGeneration === (process?.resetGeneration ?? 0)) return;
    owner = process;
    ownerGeneration = process?.resetGeneration ?? 0;

    const registry = APIRegistry.getInstance();
    const generator = process?.thunkGenerator;
    const mem = Mem.getView();
    if (!generator || !mem) {
        Logger.warn(LogCategory.SYSTEM, "[HleImages] no thunk generator or memory — images not materialized");
        return;
    }

    slotByName = new Map();
    exportsByName = new Map();
    exportsByLowerName = new Map();
    ordinalsByName = new Map();
    loadedNames = new Set();

    // Pinned names first, then everything else the APIRegistry knows, sorted so the
    // assignment does not depend on descriptor load order.
    const extra = registry.getModuleNames()
        .map(n => n.toLowerCase())
        .filter(n => !(n in HLE_IMAGE_SLOT))
        .sort();
    let nextSlot = HLE_IMAGE_FIRST_FREE_SLOT;
    const planned: Array<{ name: string; slot: number }> = [];
    for (const [name, slot] of Object.entries(HLE_IMAGE_SLOT)) {
        if (hleModuleMayHaveImage(name)) planned.push({ name, slot });
    }
    for (const name of extra) {
        if (!hleModuleMayHaveImage(name)) continue;
        if (nextSlot >= HLE_IMAGE_SLOT_COUNT) {
            Logger.warn(LogCategory.SYSTEM,
                `[HleImages] arena full at ${HLE_IMAGE_SLOT_COUNT} slots — "${name}" gets no image`);
            break;
        }
        planned.push({ name, slot: nextSlot++ });
    }

    const addressSpace = process?.addressSpace;
    let built = 0;
    for (const { name, slot } of planned) {
        const base = hleImageBaseForSlot(slot);
        const descriptor = registry.getModules().find(m => m.name.toLowerCase() === name);
        const declared = (descriptor?.functions ?? []).map(f => f.name);

        // Size FIRST. allocateStubAt REGISTERS each stub at its address, so building a slot
        // the image cannot fit would leave live stub registrations pointing into memory that
        // is never published. The check is over every declared export, so it can only be
        // conservative — an export skipped below shrinks the image, never grows it.
        if (hleModuleImageSize(name, declared) > HLE_IMAGE_SLOT_SIZE) {
            Logger.warn(LogCategory.SYSTEM,
                `[HleImages] ${name}: ${declared.length} exports exceed the 0x${HLE_IMAGE_SLOT_SIZE.toString(16)} slot — no image`);
            continue;
        }

        const exports: HleImageExport[] = [];
        for (const fn of descriptor?.functions ?? []) {
            // A stdcall export we cannot size would throw here and take the whole arena
            // with it; skipping keeps it resolvable through the on-demand path instead.
            try {
                const address = (base + 0x1000 + exports.length * 16) >>> 0;
                const args = fn.params ? calculateStackCleanup(fn.params) >> 2 : undefined;
                const existing = generator.findStubsByName(name, fn.name)[0];
                const { code } = existing
                    ? generator.allocateAliasStubAt(
                        address, existing, args, fn.callingConvention, fn.stackCleanupBytes,
                    )
                    : generator.allocateStubAt(
                        address, name, fn.name, args, fn.callingConvention, fn.stackCleanupBytes,
                    );
                exports.push({ name: fn.name, code });
            } catch (e) {
                Logger.verbose(LogCategory.SYSTEM, `[HleImages] ${name}:${fn.name} not stubbable — ${e}`);
            }
        }

        let image;
        try {
            image = buildHleModuleImage(name, base, HLE_IMAGE_SLOT_SIZE, exports);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `[HleImages] ${name}: ${e}`);
            continue;
        }

        addressSpace?.releaseRegion?.(base);
        // One write per image, no await anywhere in this function: the .text section holds
        // executable stub bodies, so the JIT invalidation must land in this same JS turn
        // (CLAUDE.md §3.1). Page-granular invalidation covers the whole slot.
        if (!writeGuestCode(mem, image.bytes, base)) {
            Logger.warn(LogCategory.SYSTEM, `[HleImages] ${name}: image write rejected at 0x${base.toString(16)}`);
            continue;
        }
        // Registered only once the bytes are actually there — an rx ROM region for an image
        // that does not exist makes a backtrace name bytes nobody wrote.
        addressSpace?.mapRegion?.(base, HLE_IMAGE_SLOT_SIZE, "rx", "ROM", "HleImages", name);

        slotByName.set(name, slot);
        exportsByName.set(name, image.exportAddresses);
        exportsByLowerName.set(name, new Map(
            [...image.exportAddresses].map(([n, a]) => [n.toLowerCase(), a])));
        ordinalsByName.set(name, image.ordinalAddresses);
        built++;
    }

    Logger.log(LogCategory.SYSTEM,
        `[HleImages] materialized ${built} module image(s) at 0x${MEM_HLE_IMAGE_BASE.toString(16)}` +
        ` (${HLE_IMAGE_SLOT_COUNT} slots of 0x${HLE_IMAGE_SLOT_SIZE.toString(16)})`);
}
