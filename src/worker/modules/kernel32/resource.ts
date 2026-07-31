/**
 * Kernel32 Resource Management functions
 *
 * PE resource loading and access - parses actual PE resource directory
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Marshaler } from '../../core/memory/marshaler';

const DEFAULT_EXE_BASE = 0x00400000;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;

// Standard Windows resource types
const RT_CURSOR = 1;
const RT_BITMAP = 2;
const RT_ICON = 3;
const RT_MENU = 4;
const RT_DIALOG = 5;
const RT_STRING = 6;
const RT_FONTDIR = 7;
const RT_FONT = 8;
const RT_ACCELERATOR = 9;
const RT_RCDATA = 10;
const RT_MESSAGETABLE = 11;
const RT_GROUP_CURSOR = 12;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

function getResourceTypeName(type: number): string {
    const names: Record<number, string> = {
        [RT_CURSOR]: 'RT_CURSOR',
        [RT_BITMAP]: 'RT_BITMAP',
        [RT_ICON]: 'RT_ICON',
        [RT_MENU]: 'RT_MENU',
        [RT_DIALOG]: 'RT_DIALOG',
        [RT_STRING]: 'RT_STRING',
        [RT_FONTDIR]: 'RT_FONTDIR',
        [RT_FONT]: 'RT_FONT',
        [RT_ACCELERATOR]: 'RT_ACCELERATOR',
        [RT_RCDATA]: 'RT_RCDATA',
        [RT_MESSAGETABLE]: 'RT_MESSAGETABLE',
        [RT_GROUP_CURSOR]: 'RT_GROUP_CURSOR',
        [RT_GROUP_ICON]: 'RT_GROUP_ICON',
        [RT_VERSION]: 'RT_VERSION',
    };
    return names[type] || `TYPE_${type}`;
}

// Resource handle info - maps HRSRC to actual resource data location
interface ResourceEntry {
    moduleBase: number;
    dataRVA: number;
    size: number;
    codePage: number;
}

// Cache of found resources (HRSRC -> ResourceEntry)
const resourceCache: Map<number, ResourceEntry> = new Map();
let nextResourceHandle = 0x80000001;

export function resetResourceCache(): void {
    resourceCache.clear();
    nextResourceHandle = 0x80000001;
}

/**
 * Parse PE resource directory to find a specific resource
 */
export function findResourceInPE(
    mem: Uint8Array,
    moduleBase: number,
    resourceType: number | string,
    resourceName: number | string
): ResourceEntry | null {
    moduleBase = System.getInstance().process?.moduleRegistry?.resolvePeModuleBase(moduleBase)
        ?? (moduleBase === 0 ? DEFAULT_EXE_BASE : moduleBase);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    // Check DOS header
    if (view.getUint16(moduleBase, true) !== 0x5A4D) {
        Logger.warn(LogCategory.KERNEL32, `FindResource: Invalid DOS header at 0x${moduleBase.toString(16)}`);
        return null;
    }

    const e_lfanew = view.getUint32(moduleBase + 0x3C, true);
    const peHeader = moduleBase + e_lfanew;

    // Verify PE signature
    if (view.getUint32(peHeader, true) !== 0x00004550) {
        Logger.warn(LogCategory.KERNEL32, `FindResource: Invalid PE header at 0x${peHeader.toString(16)}`);
        return null;
    }

    const optHeaderPtr = peHeader + 24;
    if (view.getUint16(optHeaderPtr, true) !== 0x10B) {
        Logger.warn(LogCategory.KERNEL32, `FindResource: Only 32-bit PE supported`);
        return null;
    }

    // Resource Directory is DataDirectory[2]
    // DataDirectory starts at offset 96 from optional header, each entry is 8 bytes (RVA + Size)
    // DataDirectory[2] = offset 96 + 2*8 = 112
    const resourceDirRVA = view.getUint32(optHeaderPtr + 112, true);
    const resourceDirSize = view.getUint32(optHeaderPtr + 116, true);

    if (resourceDirRVA === 0) {
        Logger.verbose(LogCategory.KERNEL32, `FindResource: No resource directory in module`);
        return null;
    }

    const resourceDirBase = moduleBase + resourceDirRVA;

    Logger.verbose(LogCategory.KERNEL32,
        `FindResource: Resource directory at RVA 0x${resourceDirRVA.toString(16)}, size=0x${resourceDirSize.toString(16)}`);

    // Parse resource directory structure:
    // Level 1: Resource Types
    // Level 2: Resource Names/IDs
    // Level 3: Language IDs
    // Level 4: Resource Data Entry

    // Find type entry
    const typeEntry = findDirectoryEntry(view, resourceDirBase, resourceDirBase, resourceType);
    if (!typeEntry) {
        Logger.verbose(LogCategory.KERNEL32,
            `FindResource: Type ${typeof resourceType === 'number' ? getResourceTypeName(resourceType) : resourceType} not found`);
        return null;
    }

    // Type entry points to name/ID directory
    const nameDirOffset = typeEntry & 0x7FFFFFFF;
    const nameDir = resourceDirBase + nameDirOffset;

    // Find name/ID entry
    const nameEntry = findDirectoryEntry(view, resourceDirBase, nameDir, resourceName);
    if (!nameEntry) {
        Logger.verbose(LogCategory.KERNEL32,
            `FindResource: Name ${typeof resourceName === 'number' ? `#${resourceName}` : resourceName} not found`);
        return null;
    }

    // Name entry points to language directory
    const langDirOffset = nameEntry & 0x7FFFFFFF;
    const langDir = resourceDirBase + langDirOffset;

    // Get first language entry (we don't care about language for now)
    const langDirInfo = readResourceDirectory(view, langDir);
    if (langDirInfo.numberOfEntries === 0) {
        Logger.verbose(LogCategory.KERNEL32, `FindResource: No language entries`);
        return null;
    }

    // Read first language entry
    const langEntryPtr = langDir + 16; // After directory header
    const langEntryData = view.getUint32(langEntryPtr + 4, true);

    // This should NOT have high bit set (it's a data entry, not another directory)
    if (langEntryData & 0x80000000) {
        Logger.warn(LogCategory.KERNEL32, `FindResource: Expected data entry, got directory`);
        return null;
    }

    // langEntryData is offset to IMAGE_RESOURCE_DATA_ENTRY
    const dataEntry = resourceDirBase + langEntryData;

    // IMAGE_RESOURCE_DATA_ENTRY structure:
    // DWORD OffsetToData;  // RVA of resource data
    // DWORD Size;
    // DWORD CodePage;
    // DWORD Reserved;
    const dataRVA = view.getUint32(dataEntry, true);
    const size = view.getUint32(dataEntry + 4, true);
    const codePage = view.getUint32(dataEntry + 8, true);

    Logger.verbose(LogCategory.KERNEL32,
        `FindResource: Found! DataRVA=0x${dataRVA.toString(16)}, Size=${size}, CodePage=${codePage}`);

    return {
        moduleBase,
        dataRVA,
        size,
        codePage
    };
}

/**
 * Return the first integer resource ID of the given type in a PE module,
 * or null if no such resource type exists.
 */
export function getFirstResourceId(
    mem: Uint8Array,
    moduleBase: number,
    resourceType: number
): number | null {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    if (view.getUint16(moduleBase, true) !== 0x5A4D) return null;
    const e_lfanew = view.getUint32(moduleBase + 0x3C, true);
    if (view.getUint32(moduleBase + e_lfanew, true) !== 0x00004550) return null;
    if (view.getUint16(moduleBase + e_lfanew + 24, true) !== 0x10B) return null;

    const optHeaderPtr = moduleBase + e_lfanew + 24;
    const resourceDirRVA = view.getUint32(optHeaderPtr + 112, true);
    if (resourceDirRVA === 0) return null;

    const resourceDirBase = moduleBase + resourceDirRVA;

    const typeEntry = findDirectoryEntry(view, resourceDirBase, resourceDirBase, resourceType);
    if (!typeEntry) return null;

    const nameDir = resourceDirBase + (typeEntry & 0x7FFFFFFF);
    const numNamed = view.getUint16(nameDir + 12, true);
    const numId    = view.getUint16(nameDir + 14, true);
    if (numId === 0) return null;

    // ID entries follow named entries in the directory
    const firstIdPtr = nameDir + 16 + numNamed * 8;
    const nameOrId = view.getUint32(firstIdPtr, true);
    if (nameOrId & 0x80000000) return null; // unexpectedly a name entry
    return nameOrId & 0xFFFF;
}

/**
 * Read IMAGE_RESOURCE_DIRECTORY header
 */
function readResourceDirectory(view: DataView, addr: number): {
    characteristics: number;
    timeDateStamp: number;
    majorVersion: number;
    minorVersion: number;
    numberOfNamedEntries: number;
    numberOfIdEntries: number;
    numberOfEntries: number;
} {
    const characteristics = view.getUint32(addr, true);
    const timeDateStamp = view.getUint32(addr + 4, true);
    const majorVersion = view.getUint16(addr + 8, true);
    const minorVersion = view.getUint16(addr + 10, true);
    const numberOfNamedEntries = view.getUint16(addr + 12, true);
    const numberOfIdEntries = view.getUint16(addr + 14, true);

    return {
        characteristics,
        timeDateStamp,
        majorVersion,
        minorVersion,
        numberOfNamedEntries,
        numberOfIdEntries,
        numberOfEntries: numberOfNamedEntries + numberOfIdEntries
    };
}

/**
 * Find an entry in a resource directory by ID or name
 * Returns the OffsetToData field (may have high bit set for subdirectory)
 */
function findDirectoryEntry(
    view: DataView,
    resourceDirBase: number,
    dirAddr: number,
    idOrName: number | string
): number | null {
    const dirInfo = readResourceDirectory(view, dirAddr);
    const entriesStart = dirAddr + 16; // After 16-byte directory header

    // IMAGE_RESOURCE_DIRECTORY_ENTRY structure (8 bytes each):
    // DWORD NameOrId;      // High bit: 1=name offset, 0=integer ID
    // DWORD OffsetToData;  // High bit: 1=subdirectory, 0=data entry

    const isSearchingById = typeof idOrName === 'number';
    const searchId = isSearchingById ? idOrName : 0;
    const searchName = isSearchingById ? '' : (idOrName as string).toUpperCase();

    for (let i = 0; i < dirInfo.numberOfEntries; i++) {
        const entryPtr = entriesStart + (i * 8);
        const nameOrId = view.getUint32(entryPtr, true);
        const offsetToData = view.getUint32(entryPtr + 4, true);

        const isNameEntry = (nameOrId & 0x80000000) !== 0;

        if (isSearchingById && !isNameEntry) {
            // Searching by ID and this is an ID entry
            if ((nameOrId & 0xFFFF) === searchId) {
                return offsetToData;
            }
        } else if (!isSearchingById && isNameEntry) {
            // Searching by name and this is a name entry
            const nameOffset = nameOrId & 0x7FFFFFFF;
            const nameAddr = resourceDirBase + nameOffset;

            // IMAGE_RESOURCE_DIR_STRING_U: WORD Length, WCHAR NameString[1]
            const nameLen = view.getUint16(nameAddr, true);
            let name = '';
            for (let j = 0; j < nameLen; j++) {
                name += String.fromCharCode(view.getUint16(nameAddr + 2 + j * 2, true));
            }

            if (name.toUpperCase() === searchName) {
                return offsetToData;
            }
        }
    }

    return null;
}

/**
 * Helper to interpret lpName/lpType which can be MAKEINTRESOURCE(id) or string pointer
 */
function interpretResourceId(mem: Uint8Array, value: number): number | string {
    // MAKEINTRESOURCE creates values < 0x10000 (actually < 0xFFFF)
    // These are passed directly as the pointer value
    if (value > 0 && value < 0x10000) {
        return value; // It's an integer ID
    }
    // Otherwise it's a pointer to a string
    if (value === 0) {
        return 0; // NULL
    }
    return Marshaler.readString(mem, value);
}

function interpretResourceIdW(mem: Uint8Array, value: number): number | string {
    if (value > 0 && value < 0x10000) {
        return value;
    }
    if (value === 0) {
        return 0;
    }
    return Marshaler.readWideString(mem, value);
}

/**
 * List language IDs present for a specific resource in a PE module.
 */
function listResourceLanguagesInPE(
    mem: Uint8Array,
    moduleBase: number,
    resourceType: number | string,
    resourceName: number | string
): number[] {
    moduleBase = System.getInstance().process?.moduleRegistry?.resolvePeModuleBase(moduleBase)
        ?? (moduleBase === 0 ? DEFAULT_EXE_BASE : moduleBase);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    if (view.getUint16(moduleBase, true) !== 0x5A4D) return [];
    const e_lfanew = view.getUint32(moduleBase + 0x3C, true);
    const peHeader = moduleBase + e_lfanew;
    if (view.getUint32(peHeader, true) !== 0x00004550) return [];

    const optHeaderPtr = peHeader + 24;
    if (view.getUint16(optHeaderPtr, true) !== 0x10B) return [];

    const resourceDirRVA = view.getUint32(optHeaderPtr + 112, true);
    if (resourceDirRVA === 0) return [];

    const resourceDirBase = moduleBase + resourceDirRVA;
    const typeEntry = findDirectoryEntry(view, resourceDirBase, resourceDirBase, resourceType);
    if (!typeEntry) return [];

    const nameDir = resourceDirBase + (typeEntry & 0x7FFFFFFF);
    const nameEntry = findDirectoryEntry(view, resourceDirBase, nameDir, resourceName);
    if (!nameEntry) return [];

    const langDir = resourceDirBase + (nameEntry & 0x7FFFFFFF);
    const langDirInfo = readResourceDirectory(view, langDir);
    const languages: number[] = [];
    const entriesStart = langDir + 16;

    for (let i = 0; i < langDirInfo.numberOfEntries; i++) {
        const entryPtr = entriesStart + i * 8;
        const nameOrId = view.getUint32(entryPtr, true);
        const offsetToData = view.getUint32(entryPtr + 4, true);
        if ((offsetToData & 0x80000000) !== 0) continue;
        languages.push(nameOrId & 0xFFFF);
    }

    return languages;
}

function enumResourceLanguagesImpl(
    ctx: any,
    mem: Uint8Array,
    args: number[],
    wide: boolean
): number | { value: number; suspendedForCallback: boolean; callbackId: number; stackCleanup: number } {
    let hModule = args[0];
    const lpType = args[1];
    const lpName = args[2];
    const lpEnumFunc = args[3];
    const lParam = args[4];

    if (!lpEnumFunc) return 0;
    if (hModule === 0) hModule = 0x00400000;

    const interpret = wide ? interpretResourceIdW : interpretResourceId;
    const resourceType = interpret(mem, lpType);
    const resourceName = interpret(mem, lpName);
    const typeDesc = typeof resourceType === 'number' ? getResourceTypeName(resourceType) : `"${resourceType}"`;
    const nameDesc = typeof resourceName === 'number' ? `#${resourceName}` : `"${resourceName}"`;
    const label = wide ? 'EnumResourceLanguagesW' : 'EnumResourceLanguagesA';

    const languages = listResourceLanguagesInPE(mem, hModule, resourceType, resourceName);
    Logger.verbose(
        LogCategory.KERNEL32,
        `${label}(hModule=0x${hModule.toString(16)}, type=${typeDesc}, name=${nameDesc}, ` +
        `callback=0x${lpEnumFunc.toString(16)}, lParam=0x${lParam.toString(16)}, langs=[${languages.map(l => `0x${l.toString(16)}`).join(', ')}])`
    );

    if (languages.length === 0) {
        return 1;
    }

    const callbackManager = System.getInstance().process?.dispatcher?.callbackManager;
    if (!callbackManager) {
        return 1;
    }

    let index = 0;
    let firstCallbackId: number | null = null;
    let enumFailed = false;

    const processNext = (): void => {
        if (enumFailed || index >= languages.length) return;

        const lang = languages[index++];
        const { callbackId } = callbackManager.invokeCallback(
            lpEnumFunc,
            [hModule, lpType, lpName, lang & 0xFFFF, lParam],
            0,
            (ret) => {
                if (ret === 0) {
                    enumFailed = true;
                    return 0;
                }
                if (index >= languages.length) {
                    return 1;
                }
                return null;
            },
            false,
            label
        );

        if (firstCallbackId === null) {
            firstCallbackId = callbackId;
        }

        const invocation = callbackManager.getPendingCallback(callbackId);
        if (invocation) {
            invocation.enumerationState = {
                continueEnumeration: processNext,
                finishEnumeration: () => {},
            };

            if (callbackId !== firstCallbackId && firstCallbackId !== null) {
                const firstInvocation = callbackManager.getPendingCallback(firstCallbackId);
                if (firstInvocation?.thunkContext) {
                    invocation.thunkContext = firstInvocation.thunkContext;
                }
            }
        }
    };

    processNext();

    return {
        value: 1,
        suspendedForCallback: true,
        callbackId: firstCallbackId || 0,
        stackCleanup: 5 * 4,
    };
}

export const exports: Record<string, ThunkImplementation> = {
    /**
     * FindResourceA - Locates a resource in a module
     * @param hModule - Handle to module containing resource (NULL = current executable)
     * @param lpName - Resource name or ID (MAKEINTRESOURCE)
     * @param lpType - Resource type (RT_* or MAKEINTRESOURCE)
     * @returns Resource handle (HRSRC) or NULL if not found
     */
    'FindResourceA': (ctx, mem, args) => {
        let hModule = args[0];
        const lpName = args[1];
        const lpType = args[2];

        // NULL module means main executable
        if (hModule === 0) {
            hModule = 0x00400000; // Default EXE base
        }

        const resourceName = interpretResourceId(mem, lpName);
        const resourceType = interpretResourceId(mem, lpType);

        const typeDesc = typeof resourceType === 'number' ? getResourceTypeName(resourceType) : `"${resourceType}"`;
        const nameDesc = typeof resourceName === 'number' ? `#${resourceName}` : `"${resourceName}"`;

        Logger.verbose(LogCategory.KERNEL32,
            `FindResourceA(hModule=0x${hModule.toString(16)}, lpName=${nameDesc}, lpType=${typeDesc})`);

        // Search for the resource in the PE
        const entry = findResourceInPE(mem, hModule, resourceType, resourceName);

        if (!entry) {
            Logger.log(LogCategory.KERNEL32,
                `FindResourceA: Resource ${typeDesc}/${nameDesc} not found in module 0x${hModule.toString(16)}`);
            return 0; // NULL - not found
        }

        // Allocate a handle and cache the entry
        const hrsrc = nextResourceHandle++;
        resourceCache.set(hrsrc, entry);

        Logger.log(LogCategory.KERNEL32,
            `FindResourceA: Found ${typeDesc}/${nameDesc} -> HRSRC=0x${hrsrc.toString(16)}, ` +
            `DataRVA=0x${entry.dataRVA.toString(16)}, Size=${entry.size}`);

        return hrsrc;
    },

    /**
     * FindResourceW - Wide version
     */
    'FindResourceW': (ctx, mem, args) => {
        let hModule = args[0];
        const lpName = args[1];
        const lpType = args[2];

        if (hModule === 0) {
            hModule = 0x00400000;
        }

        const resourceName = interpretResourceIdW(mem, lpName);
        const resourceType = interpretResourceIdW(mem, lpType);

        const typeDesc = typeof resourceType === 'number' ? getResourceTypeName(resourceType) : `"${resourceType}"`;
        const nameDesc = typeof resourceName === 'number' ? `#${resourceName}` : `"${resourceName}"`;

        Logger.verbose(LogCategory.KERNEL32,
            `FindResourceW(hModule=0x${hModule.toString(16)}, lpName=${nameDesc}, lpType=${typeDesc})`);

        const entry = findResourceInPE(mem, hModule, resourceType, resourceName);

        if (!entry) {
            Logger.log(LogCategory.KERNEL32,
                `FindResourceW: Resource ${typeDesc}/${nameDesc} not found`);
            return 0;
        }

        const hrsrc = nextResourceHandle++;
        resourceCache.set(hrsrc, entry);

        Logger.log(LogCategory.KERNEL32,
            `FindResourceW: Found ${typeDesc}/${nameDesc} -> HRSRC=0x${hrsrc.toString(16)}`);

        return hrsrc;
    },

    /**
     * FindResourceExA - Extended version with language
     */
    'FindResourceExA': (ctx, mem, args) => {
        let hModule = args[0];
        const lpType = args[1];
        const lpName = args[2];
        const wLanguage = args[3];

        if (hModule === 0) {
            hModule = 0x00400000;
        }

        // Note: parameter order is different from FindResourceA!
        const resourceName = interpretResourceId(mem, lpName);
        const resourceType = interpretResourceId(mem, lpType);

        Logger.verbose(LogCategory.KERNEL32,
            `FindResourceExA(hModule=0x${hModule.toString(16)}, type=${resourceType}, name=${resourceName}, lang=${wLanguage})`);

        // For now, ignore language and use same logic as FindResourceA
        const entry = findResourceInPE(mem, hModule, resourceType, resourceName);

        if (!entry) {
            return 0;
        }

        const hrsrc = nextResourceHandle++;
        resourceCache.set(hrsrc, entry);
        return hrsrc;
    },

    /**
     * EnumResourceNamesA - enumerate resource names of a given type.
     * Compatibility stub: report success without callback invocation.
     */
    'EnumResourceNamesA': (ctx, mem, args) => {
        const hModule = args[0];
        const lpType = args[1];
        const lpEnumFunc = args[2];
        const lParam = args[3];
        const resourceType = interpretResourceId(mem, lpType);
        const typeDesc = typeof resourceType === 'number' ? getResourceTypeName(resourceType) : `"${resourceType}"`;

        Logger.verbose(
            LogCategory.KERNEL32,
            `EnumResourceNamesA(hModule=0x${hModule.toString(16)}, type=${typeDesc}, callback=0x${lpEnumFunc.toString(16)}, lParam=0x${lParam.toString(16)})`
        );

        // Conservative behavior (matching other enum stubs in this codebase):
        // return success even when we do not walk callbacks yet.
        return 1;
    },

    /**
     * EnumResourceNamesW - wide variant.
     * Compatibility stub: report success without callback invocation.
     */
    'EnumResourceNamesW': (ctx, mem, args) => {
        const hModule = args[0];
        const lpType = args[1];
        const lpEnumFunc = args[2];
        const lParam = args[3];
        const resourceType = interpretResourceIdW(mem, lpType);
        const typeDesc = typeof resourceType === 'number' ? getResourceTypeName(resourceType) : `"${resourceType}"`;

        Logger.verbose(
            LogCategory.KERNEL32,
            `EnumResourceNamesW(hModule=0x${hModule.toString(16)}, type=${typeDesc}, callback=0x${lpEnumFunc.toString(16)}, lParam=0x${lParam.toString(16)})`
        );

        return 1;
    },

    /**
     * EnumResourceLanguagesA - enumerate language IDs for a specific resource.
     */
    'EnumResourceLanguagesA': (ctx, mem, args) => {
        return enumResourceLanguagesImpl(ctx, mem, args, false);
    },

    /**
     * EnumResourceLanguagesW - wide variant.
     */
    'EnumResourceLanguagesW': (ctx, mem, args) => {
        return enumResourceLanguagesImpl(ctx, mem, args, true);
    },

    /**
     * LoadResource - Loads a resource into memory
     * @param hModule - Handle to module containing resource
     * @param hResInfo - Handle to resource (from FindResource)
     * @returns Global handle to resource data or NULL on error
     */
    'LoadResource': (ctx, mem, args) => {
        const hModule = args[0];
        const hResInfo = args[1];

        Logger.verbose(LogCategory.KERNEL32,
            `LoadResource(hModule=0x${hModule.toString(16)}, hResInfo=0x${hResInfo.toString(16)})`);

        if (!hResInfo) {
            Logger.warn(LogCategory.KERNEL32, 'LoadResource: NULL resource handle');
            return 0;
        }

        const entry = resourceCache.get(hResInfo);
        if (!entry) {
            Logger.warn(LogCategory.KERNEL32,
                `LoadResource: Invalid/unknown resource handle 0x${hResInfo.toString(16)}`);
            return 0;
        }

        // LoadResource returns a handle that can be passed to LockResource
        // In Win32, this is essentially the same as the HRSRC for memory-mapped resources
        // We return the HRSRC itself since LockResource will look it up
        Logger.verbose(LogCategory.KERNEL32,
            `LoadResource: Returning handle 0x${hResInfo.toString(16)} for resource at RVA 0x${entry.dataRVA.toString(16)}`);

        return hResInfo;
    },

    /**
     * SizeofResource - Returns the size of a resource
     * @param hModule - Handle to module containing resource
     * @param hResInfo - Handle to resource
     * @returns Size in bytes or 0 on error
     */
    'SizeofResource': (ctx, mem, args) => {
        const hModule = args[0];
        const hResInfo = args[1];

        if (!hResInfo) {
            return 0;
        }

        const entry = resourceCache.get(hResInfo);
        if (!entry) {
            Logger.warn(LogCategory.KERNEL32,
                `SizeofResource: Invalid resource handle 0x${hResInfo.toString(16)}`);
            return 0;
        }

        Logger.verbose(LogCategory.KERNEL32, `SizeofResource: Resource size = ${entry.size} bytes`);
        return entry.size;
    },

    /**
     * LockResource - Locks a resource in memory and returns a pointer
     * @param hResData - Handle to resource (from LoadResource)
     * @returns Pointer to first byte of resource or NULL on error
     */
    'LockResource': (ctx, mem, args) => {
        const hResData = args[0];

        if (!hResData) {
            Logger.warn(LogCategory.KERNEL32, 'LockResource: NULL resource handle');
            return 0;
        }

        const entry = resourceCache.get(hResData);
        if (!entry) {
            Logger.warn(LogCategory.KERNEL32,
                `LockResource: Invalid resource handle 0x${hResData.toString(16)}`);
            return 0;
        }

        // Return absolute address of resource data in memory
        // The resource data is at moduleBase + dataRVA
        const dataAddr = entry.moduleBase + entry.dataRVA;

        Logger.verbose(LogCategory.KERNEL32,
            `LockResource: Returning pointer 0x${dataAddr.toString(16)} for resource 0x${hResData.toString(16)}`);

        return dataAddr;
    },

    /**
     * FreeResource - Frees a loaded resource (obsolete in Win32, always returns FALSE)
     */
    'FreeResource': (ctx, mem, args) => {
        const hResData = args[0];
        Logger.verbose(LogCategory.KERNEL32, `FreeResource(0x${hResData.toString(16)}) - no-op in Win32`);
        // In Win32, this is a no-op that always returns FALSE
        // Resources are automatically freed when the module is unloaded
        return 0; // FALSE
    },

    /**
     * BeginUpdateResourceA - open an executable file for in-place resource updates.
     * Returns an update handle for UpdateResource/EndUpdateResource, or NULL on failure.
     */
    'BeginUpdateResourceA': (ctx, mem, args) => {
        const lpFileName = args[0] >>> 0;
        const bDeleteExistingResources = args[1] !== 0;

        if (!lpFileName) {
            return 0;
        }

        const path = Marshaler.readString(mem, lpFileName);
        const vfs = System.getInstance().fileSystem;
        if (!vfs) {
            return 0;
        }

        const vfsHandle = vfs.openSync(path, GENERIC_READ | GENERIC_WRITE, OPEN_EXISTING);
        if (!vfsHandle) {
            Logger.verbose(LogCategory.KERNEL32, `BeginUpdateResourceA: failed to open "${path}"`);
            return 0;
        }

        const handle = System.getInstance().resourceProvider.registerKernelObject({
            kind: 'resource_update',
            path,
            vfsHandle,
            deleteExisting: bDeleteExistingResources,
        });

        Logger.verbose(
            LogCategory.KERNEL32,
            `BeginUpdateResourceA("${path}", delete=${bDeleteExistingResources}) -> 0x${handle.toString(16)}`
        );
        return handle;
    },
};
