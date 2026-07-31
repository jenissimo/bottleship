/**
 * Validate the SHIPPED Win32 struct offset tables against known SDK sizes and layout rules.
 * Run: bun tools/validate-struct-offsets.ts
 *
 * The oracle is the SDK: `expectedSize` and every field size live here, hardcoded, because
 * they are what the guest's compiler baked into the binary. The offsets come from the table
 * the emulator actually reads and writes — never a copy kept here. A spec that carries its
 * own offsets validates itself and stays green while the shipped table drifts, which is the
 * exact failure this gate exists to catch.
 *
 * Tables are read out of the TypeScript SOURCE rather than imported: `ddraw/constants.ts` and
 * `emulator-config.ts` sit in import cycles that only resolve inside the worker, so importing
 * them here fails at module-eval time. The tables are flat numeric literals, so lifting them
 * textually is exact — and an entry this reader cannot parse is an ERROR, not a skip.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

// ---------------------------------------------------------------------------
// Shipped-table reader
// ---------------------------------------------------------------------------

interface ParsedTable { offsets: Record<string, number>; unparsed: string[]; }

const fileCache = new Map<string, Map<string, ParsedTable>>();

function stripComments(s: string): string {
    return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function tablesOf(file: string): Map<string, ParsedTable> {
    const cached = fileCache.get(file);
    if (cached) return cached;
    const text = stripComments(readFileSync(join(SRC, file), "utf8"));
    const out = new Map<string, ParsedTable>();
    for (const m of text.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{([^{}]*)\}/g)) {
        const offsets: Record<string, number> = {};
        const unparsed: string[] = [];
        for (const part of m[2]!.split(",")) {
            if (!part.trim()) continue;
            const e = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(0x[0-9a-fA-F]+|\d+)\s*$/.exec(part);
            if (e) offsets[e[1]!] = Number(e[2]);
            else unparsed.push(part.trim());
        }
        out.set(m[1]!, { offsets, unparsed });
    }
    fileCache.set(file, out);
    return out;
}

// ---------------------------------------------------------------------------
// Specs — SDK truth here, offsets from the shipped table named by `source`.
// ---------------------------------------------------------------------------

interface StructSpec {
    name: string;
    /** sizeof() per the SDK, x86. */
    expectedSize: number;
    /** #pragma pack(N) / natural struct alignment. Default 4. */
    packAlignment?: number;
    /** The shipped table: file under src/, and the exported const holding it. */
    source: { file: string; table: string };
    /** Field byte sizes. Anything not listed is a DWORD. */
    sizes?: Record<string, number>;
    /** Last field by offset, used to derive sizeof from the shipped offsets. */
    lastField: { name: string; size: number };
    /** Field groups that legitimately share bytes (unions, or a container plus its members). */
    aliases?: string[][];
}

const DDSCAPS2 = 16, DDCOLORKEY = 8, DDPIXELFORMAT = 32, GUID = 16, ROPS = 32;

const STRUCT_SPECS: StructSpec[] = [
    {
        name: "DDSURFACEDESC2",
        expectedSize: 124,
        source: { file: "worker/modules/ddraw/constants.ts", table: "DDSURFACEDESC2_OFFSETS" },
        sizes: {
            ddckCKDestOverlay: DDCOLORKEY, ddckCKDestBlt: DDCOLORKEY,
            ddckCKSrcOverlay: DDCOLORKEY, ddckCKSrcBlt: DDCOLORKEY,
            pixelFormat: DDPIXELFORMAT, caps: DDSCAPS2,
        },
        aliases: [["caps", "dwCaps2", "dwCaps3", "dwCaps4"]],
        lastField: { name: "dwTextureStage", size: 4 },
    },
    {
        name: "DDSURFACEDESC",
        expectedSize: 108,
        source: { file: "worker/modules/ddraw/constants.ts", table: "DDSURFACEDESC_OFFSETS" },
        sizes: { pixelFormat: DDPIXELFORMAT, caps: 4 },
        lastField: { name: "caps", size: 4 },
    },
    {
        name: "DDPIXELFORMAT",
        expectedSize: 32,
        source: { file: "worker/modules/ddraw/constants.ts", table: "DDPIXELFORMAT_OFFSETS" },
        lastField: { name: "aMask", size: 4 },
    },
    {
        name: "DDCAPS (DX7)",
        expectedSize: 380,
        source: { file: "worker/modules/ddraw/constants.ts", table: "DDCAPS_OFFSETS" },
        sizes: {
            dwRops: ROPS, dwSVBRops: ROPS, dwVSBRops: ROPS, dwSSBRops: ROPS, dwNLVBRops: ROPS,
            ddsOldCaps: 4, ddsCaps: DDSCAPS2,
        },
        lastField: { name: "ddsCaps", size: DDSCAPS2 },
    },
    {
        name: "DDDEVICEIDENTIFIER2",
        // 1068 laid out, padded to 1072: LARGE_INTEGER gives the struct 8-byte alignment.
        expectedSize: 1072,
        packAlignment: 8,
        source: { file: "worker/modules/ddraw/constants.ts", table: "DDDEVICEIDENTIFIER2_OFFSETS" },
        sizes: { szDriver: 512, szDescription: 512, liDriverVersion: 8, guidDeviceIdentifier: GUID },
        lastField: { name: "dwWHQLLevel", size: 4 },
    },
    {
        name: "D3DDEVICEDESC (DX6)",
        expectedSize: 252,
        source: { file: "worker/core/cpu/emulator-config.ts", table: "D3DDEVICEDESC_OFFSETS" },
        sizes: {
            dtcTransformCaps: 8, dlcLightingCaps: 16, dpcLineCaps: 56, dpcTriCaps: 56,
            wMaxTextureBlendStages: 2, wMaxSimultaneousTextures: 2,
        },
        lastField: { name: "wMaxSimultaneousTextures", size: 2 },
    },
    {
        name: "D3DPRIMCAPS",
        expectedSize: 56,
        source: { file: "worker/core/cpu/emulator-config.ts", table: "D3DPRIMCAPS_OFFSETS" },
        lastField: { name: "dwStippleHeight", size: 4 },
    },
    {
        name: "D3DMATERIAL7",
        expectedSize: 68,
        source: { file: "worker/modules/ddraw/constants.ts", table: "D3DMATERIAL7_OFFSETS" },
        sizes: { diffuse: 16, ambient: 16, specular: 16, emissive: 16 },
        lastField: { name: "power", size: 4 },
    },
    {
        name: "D3DLIGHT7",
        expectedSize: 104,
        source: { file: "worker/modules/ddraw/constants.ts", table: "D3DLIGHT7_OFFSETS" },
        sizes: { diffuse: 16, specular: 16, ambient: 16, position: 12, direction: 12 },
        lastField: { name: "phi", size: 4 },
    },
    {
        name: "D3DCOLORVALUE",
        expectedSize: 16,
        source: { file: "worker/modules/ddraw/constants.ts", table: "D3DCOLORVALUE_OFFSETS" },
        lastField: { name: "a", size: 4 },
    },
    {
        name: "D3DVECTOR",
        expectedSize: 12,
        source: { file: "worker/modules/ddraw/constants.ts", table: "D3DVECTOR_OFFSETS" },
        lastField: { name: "z", size: 4 },
    },
    {
        name: "PALETTEENTRY",
        expectedSize: 4,
        packAlignment: 1,
        source: { file: "worker/modules/ddraw/constants.ts", table: "PALETTEENTRY_OFFSETS" },
        sizes: { peRed: 1, peGreen: 1, peBlue: 1, peFlags: 1 },
        lastField: { name: "peFlags", size: 1 },
    },
    {
        name: "DEV_BROADCAST_HDR",
        expectedSize: 12,
        source: { file: "worker/modules/user32/dev-broadcast.ts", table: "DEV_BROADCAST_HDR_OFFSETS" },
        lastField: { name: "dbch_reserved", size: 4 },
    },
    {
        name: "DEV_BROADCAST_DEVICEINTERFACE",
        expectedSize: 32,
        source: { file: "worker/modules/user32/dev-broadcast.ts", table: "DEV_BROADCAST_DEVICEINTERFACE_OFFSETS" },
        // dbcc_name is char[1]/WCHAR[1] in the header; the real name follows inline and
        // dbcc_size covers it. sizeof() is the padded 32.
        sizes: { dbcc_classguid: GUID, dbcc_name: 1 },
        lastField: { name: "dbcc_name", size: 1 },
    },
    // CRT structs: same ABI contract as the Win32 ones — a game reads st_mode/attrib at a
    // fixed offset, so a drift silently turns every stat into "type unknown".
    {
        name: "struct _stat (_stat32)",
        expectedSize: 36,
        source: { file: "worker/modules/crt-vc9-io.ts", table: "STAT32_OFFSETS" },
        sizes: { st_ino: 2, st_mode: 2, st_nlink: 2, st_uid: 2, st_gid: 2 },
        lastField: { name: "st_ctime", size: 4 },
    },
    {
        name: "struct _stat64i32",
        expectedSize: 48,
        source: { file: "worker/modules/crt-vc9-io.ts", table: "STAT64I32_OFFSETS" },
        sizes: { st_ino: 2, st_mode: 2, st_nlink: 2, st_uid: 2, st_gid: 2, st_atime: 8, st_mtime: 8, st_ctime: 8 },
        lastField: { name: "st_ctime", size: 8 },
    },
    {
        name: "struct __stat64",
        expectedSize: 56,
        source: { file: "worker/modules/crt-vc9-io.ts", table: "STAT64_OFFSETS" },
        sizes: { st_ino: 2, st_mode: 2, st_nlink: 2, st_uid: 2, st_gid: 2, st_size: 8, st_atime: 8, st_mtime: 8, st_ctime: 8 },
        lastField: { name: "st_ctime", size: 8 },
    },
    {
        name: "struct _finddata_t",
        expectedSize: 280,
        source: { file: "worker/modules/crt-vc9-io.ts", table: "FINDDATA32_OFFSETS" },
        sizes: { name: 260 },
        lastField: { name: "name", size: 260 },
    },
    {
        name: "struct _finddata64i32_t",
        expectedSize: 296,
        source: { file: "worker/modules/crt-vc9-io.ts", table: "FINDDATA64I32_OFFSETS" },
        sizes: { time_create: 8, time_access: 8, time_write: 8, name: 260 },
        lastField: { name: "name", size: 260 },
    },
    // LOGPEN is read by CreatePenIndirect and written by GetObject(OBJ_PEN); a drift in
    // lopnWidth (a POINT, not a LONG) silently reads the colour as the width.
    {
        name: "LOGPEN",
        expectedSize: 16,
        source: { file: "worker/modules/gdi32/gdi-objects.ts", table: "LOGPEN_OFFSETS" },
        lastField: { name: "lopnColor", size: 4 },
    },
];

/**
 * Structs the emulator reads field-by-field with inline `ptr + N` arithmetic instead of a
 * shipped offset table. There is nothing here to validate — a spec for one would only
 * compare this file against itself — so they are named, not silently absent.
 */
const UNGUARDED = ["WNDCLASSEXA", "WNDCLASSA", "MSG", "RECT", "CRITICAL_SECTION"];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

let errors = 0;
let warnings = 0;
const fail = (msg: string) => { console.error(`  ERROR: ${msg}`); errors++; };

for (const spec of STRUCT_SPECS) {
    const table = tablesOf(spec.source.file).get(spec.source.table);
    if (!table) {
        fail(`${spec.name} - shipped table ${spec.source.table} not found in src/${spec.source.file}`);
        continue;
    }
    if (table.unparsed.length > 0) {
        fail(`${spec.name} - ${spec.source.table} has entries this reader cannot evaluate: ${table.unparsed.join(" | ")}`);
        continue;
    }
    const offsets = table.offsets;
    const sizeOf = (field: string) => spec.sizes?.[field] ?? 4;

    // 1. sizeof() derived from the shipped offsets must match the SDK.
    const lastOffset = offsets[spec.lastField.name];
    if (lastOffset === undefined) {
        fail(`${spec.name} - lastField '${spec.lastField.name}' not in ${spec.source.table}`);
        continue;
    }
    const computedSize = lastOffset + spec.lastField.size;
    const align = spec.packAlignment ?? 4;
    const alignedSize = Math.ceil(computedSize / align) * align;
    if (computedSize !== spec.expectedSize && alignedSize !== spec.expectedSize) {
        fail(`${spec.name} - computed size ${computedSize} (aligned: ${alignedSize}) != SDK ${spec.expectedSize}`);
    }

    // 2. No field may extend into the next one. This is the check that needs SIZES: comparing
    //    offsets alone against a list already sorted by offset can only ever say "sorted".
    const aliasOf = new Map<string, number>();
    spec.aliases?.forEach((group, i) => group.forEach((f) => aliasOf.set(f, i)));
    const entries = Object.entries(offsets).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    for (let i = 1; i < entries.length; i++) {
        const [prevName, prevOff] = entries[i - 1]!;
        const [name, off] = entries[i]!;
        const end = prevOff + sizeOf(prevName);
        if (end <= off) continue;
        const g = aliasOf.get(prevName);
        if (g !== undefined && g === aliasOf.get(name)) continue;
        fail(
            `${spec.name} - '${prevName}' (${prevOff}+${sizeOf(prevName)}) overlaps '${name}' (${off}). ` +
            "Declare the pair in `aliases` if it is a union.",
        );
    }

    // 3. No field may start at or past the end of the struct, and none may run past it.
    for (const [field, offset] of entries) {
        if (offset < 0) fail(`${spec.name}.${field} has negative offset ${offset}`);
        else if (offset >= spec.expectedSize) fail(`${spec.name}.${field} offset ${offset} >= sizeof ${spec.expectedSize}`);
        else if (offset + sizeOf(field) > spec.expectedSize) {
            fail(`${spec.name}.${field} runs to ${offset + sizeOf(field)}, past sizeof ${spec.expectedSize}`);
        }
    }

    // 4. DWORD-shaped field names must be 4-byte aligned.
    for (const [field, offset] of entries) {
        if (/^(dw|lp|h[A-Z]|cb)/.test(field) && (offset & 3) !== 0) {
            console.warn(`  WARN: ${spec.name}.${field} at offset ${offset} is not 4-byte aligned (expected DWORD)`);
            warnings++;
        }
    }
}

console.log("");
console.log(`Validated ${STRUCT_SPECS.length} shipped struct tables`);
console.log(`Unguarded (no shipped offset table to check): ${UNGUARDED.join(", ")}`);
if (errors === 0 && warnings === 0) {
    console.log("All struct offsets validated successfully!");
} else {
    if (errors > 0) console.error(`${errors} error(s) found!`);
    if (warnings > 0) console.warn(`${warnings} warning(s) found`);
    if (errors > 0) process.exit(1);
}
