import { BlobSource, ZipArchive } from "@bottleship/formats/zip";
import type { WgbManifest } from "../worker/runtime/filesystem/wgb-loader";

export function splitGuestArgs(line: string): string[] {
    const args: string[] = [];
    let value = "", quoted = false, started = false;
    for (let i = 0; i < line.length;) {
        let count = 0;
        while (line[i] === "\\") { count++; i++; }
        if (line[i] === '"') {
            value += "\\".repeat(count >> 1);
            if (count % 2) value += '"';
            else if (quoted && line[i + 1] === '"') { value += '"'; i++; }
            else quoted = !quoted;
            started = true; i++; continue;
        }
        value += "\\".repeat(count);
        started ||= count > 0;
        if (i === line.length) break;
        const c = line[i++];
        if (!quoted && /[ \t]/.test(c)) {
            if (started) args.push(value);
            started = false; value = "";
        } else { value += c; started = true; }
    }
    if (started) args.push(value);
    return args;
}

function relativePath(path: string): string {
    const value = path.replaceAll("\\", "/");
    if (value.split("/").some(s => !s || s === ".." || s === "." || s.includes(":"))) {
        throw Error("Invalid bundle path: " + path);
    }
    return value;
}

export async function readWwtBundle(blob: Blob) {
    const archive = new ZipArchive(new BlobSource(blob));
    await archive.init();
    const descriptor = archive.getEntry("manifest.json");
    if (!descriptor) throw Error("WGB manifest is missing");
    const manifest = JSON.parse(new TextDecoder().decode(await archive.readEntry(descriptor))) as WgbManifest;
    if (![1, 2].includes(manifest.formatVersion)) throw Error("Unsupported WGB format version");
    const rom = relativePath((manifest.rom || "rom").replace(/[\\/]+$/, "")) + "/";
    const entrypoint = relativePath(manifest.entrypoint);
    const files: Record<string, ArrayBuffer> = Object.create(null);
    const times: Record<string, number> = Object.create(null);
    const names = new Set<string>();
    let exeBytes: ArrayBuffer | undefined, exePath = "";
    for (const entry of archive.listEntries()) {
        const name = entry.name.replaceAll("\\", "/");
        if (entry.isDirectory || name.endsWith("/") || !name.toLowerCase().startsWith(rom.toLowerCase())) continue;
        const path = relativePath(name.slice(rom.length));
        const key = path.toLowerCase();
        if (names.has(key)) throw Error("Duplicate Windows path: " + path);
        names.add(key);
        const bytes = await archive.readEntry(entry);
        const buffer = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer : Uint8Array.from(bytes).buffer;
        if (entry.modified !== undefined) times[path] = entry.modified * 1000;
        if (name.toLowerCase() === entrypoint.toLowerCase()) { exePath = path; exeBytes = buffer; }
        else files[path] = buffer;
    }
    if (!exeBytes) throw Error("Missing WGB entrypoint: " + entrypoint);
    const pe = new DataView(exeBytes);
    if (pe.byteLength < 64 || pe.getUint16(0, true) !== 0x5a4d) throw Error("Expected a PE executable");
    const header = pe.getUint32(0x3c,true);
    if (header + 6 > pe.byteLength || pe.getUint32(header,true) !== 0x4550 || pe.getUint16(header+4,true) !== 0x14c) throw Error("The WWT experiment supports i386 PE files");
    const displaySize = manifest.emulator?.screenResolution;
    return { displaySize, exeName: exePath.split("/").pop()!, exePath, exeBytes, files, times, argv: splitGuestArgs(manifest.args || "") };
}
