import type { HarnessService } from "../service";
import { System } from "../../core/system";
import { Mem } from "../../core/memory/mem-accessor";

/** Find a string's live copies and their surrounding bytes before setting a watchpoint. */
export function registerMemoryCommands(svc: HarnessService): void {
    svc.register("memoryFind", (args) => {
        const text = String(args[0] ?? "");
        const opts = (args[1] ?? {}) as {
            encoding?: "utf8" | "utf16le" | "hex";
            start?: number; end?: number; limit?: number; context?: number;
        };
        let needle: Uint8Array;
        if (opts.encoding === "hex") {
            const hex = text.replace(/\s/g, "");
            if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("memoryFind: invalid hex bytes");
            needle = Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
        } else if (opts.encoding === "utf16le") {
            needle = new Uint8Array(text.length * 2);
            for (let i = 0; i < text.length; i++) {
                needle[i * 2] = text.charCodeAt(i) & 255;
                needle[i * 2 + 1] = text.charCodeAt(i) >>> 8;
            }
        } else needle = new TextEncoder().encode(text);
        if (!needle.length) throw new Error("memoryFind: empty pattern");
        const process = System.getInstance().process;
        if (!process) throw new Error("memoryFind: no process");
        const limit = Math.max(1, Math.min(1024, opts.limit ?? 64));
        const context = Math.max(0, Math.min(256, opts.context ?? 32));
        const seen = new Set<number>();
        const hits = [];
        let searchedBytes = 0;
        for (const region of process.addressSpace.getRegions()) {
            if (region.perms === "noaccess") continue;
            const start = Math.max(region.base, opts.start ?? 0);
            const end = Math.min(region.base + region.size, opts.end ?? Infinity);
            if (end - start < needle.length) continue;
            const bytes = Mem.readBytes(start, end - start);
            if (!bytes) continue;
            searchedBytes += bytes.length;
            for (let i = bytes.indexOf(needle[0]!); i >= 0; i = bytes.indexOf(needle[0]!, i + 1)) {
                if (i + needle.length > bytes.length) break;
                let matches = true;
                for (let j = 1; j < needle.length; j++) {
                    if (bytes[i + j] !== needle[j]) { matches = false; break; }
                }
                const address = start + i;
                if (!matches || seen.has(address)) continue;
                seen.add(address);
                const lo = Math.max(0, i - context);
                const surrounding = bytes.subarray(lo, Math.min(bytes.length, i + needle.length + context));
                hits.push({address, region: region.kind, contextAddress: start + lo,
                    hex: Array.from(surrounding, b => b.toString(16).padStart(2, "0")).join(""),
                    ascii: Array.from(surrounding, b => b >= 32 && b < 127 ? String.fromCharCode(b) : ".").join("")});
                if (hits.length >= limit) return {hits, searchedBytes, truncated: true};
            }
        }
        return {hits, searchedBytes, truncated: false};
    });
}
