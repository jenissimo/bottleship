#!/usr/bin/env bun
/**
 * Inspect Inno Setup installer headers.
 * Usage: bun tools/inno-inspect.ts <installer.exe> [--json out.json]
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
    BufferSource,
    parseInnoHeader,
} from "@bottleship/formats/inno";
import { UnpackDecoder } from "@bottleship/formats/unpack";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error("Usage: bun tools/inno-inspect.ts <installer.exe> [--json out.json]");
        process.exit(1);
    }

    const exePath = resolve(args[0]!);
    let jsonOut: string | null = null;
    const jsonIdx = args.indexOf("--json");
    if (jsonIdx >= 0 && args[jsonIdx + 1]) jsonOut = resolve(args[jsonIdx + 1]!);

    const data = new Uint8Array(readFileSync(exePath));
    const source = new BufferSource(data);

    const wasmPath = resolve(import.meta.dir, "../public/unpack-streaming.wasm");
    const wasmBytes = readFileSync(wasmPath);
    const lzma = new UnpackDecoder();
    await lzma.init(wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength));

    const result = await parseInnoHeader(source, lzma);
    const { version, header, directories, files, icons, registryEntries, dataEntries, offsets } = result;

    const summary = {
        version: version.toString(),
        rawVersion: version.rawString,
        headerOffset: offsets.headerOffset,
        dataOffset: offsets.dataOffset,
        appName: header.appName,
        appVersion: header.appVersion,
        compression: header.compression,
        fileCount: files.length,
        headerFileCount: header.fileCount,
        dataEntryCount: dataEntries.length,
        iconCount: icons.length,
        registryCount: registryEntries.length,
        totalDataBytes: dataEntries.reduce((s, e) => s + Number(e.fileSize), 0),
        directories: directories.map((d) => d.name),
        files: files.map((f) => ({
            source: f.source,
            destination: f.destination,
            location: f.location,
            externalSize: f.externalSize.toString(),
        })),
        icons: icons.map((i) => ({ name: i.name, filename: i.filename })),
        registry: registryEntries.map((r) => ({ key: r.key, name: r.name, type: r.type })),
    };

    console.log(`Version: ${summary.version}`);
    console.log(`App: ${summary.appName} (${summary.appVersion})`);
    console.log(`Files: ${summary.fileCount} (header says ${summary.headerFileCount})`);
    console.log(`Data entries: ${summary.dataEntryCount}, total payload ${summary.totalDataBytes} bytes`);
    console.log(`Icons: ${summary.iconCount}, Registry: ${summary.registryCount}`);
    console.log(`[Dirs]: ${directories.length}`);
    for (const d of directories) console.log(`  ${d.name}`);
    console.log(`Offsets: header=0x${offsets.headerOffset.toString(16)} data=0x${offsets.dataOffset.toString(16)}`);

    if (jsonOut) {
        writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
        console.log(`Wrote ${jsonOut}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
