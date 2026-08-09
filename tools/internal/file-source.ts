/**
 * File-descriptor-backed RandomAccessSource for the Bun/Node CLIs.
 *
 * Multi-GB installer slices cannot be read whole: Bun's readFileSync panics on a
 * file larger than 2 GiB ("attempt to cast negative value to unsigned integer" —
 * a >2^31 Buffer length overflow), and it is a hard abort, not a catchable throw.
 * Ranged reads through an fd have no such limit, and the parsers only ever need
 * windows, so slices stay off the heap entirely.
 */

import { openSync, readSync, fstatSync } from "node:fs";
import type { RandomAccessSource } from "@bottleship/formats/unpack/source";

export class FileSource implements RandomAccessSource {
    readonly size: number;
    private readonly fd: number;

    constructor(path: string) {
        this.fd = openSync(path, "r");
        this.size = Number(fstatSync(this.fd, { bigint: true }).size);
    }

    readRangeSync(start: number, end: number): Uint8Array {
        const from = Math.max(0, Math.min(start, this.size));
        const to = Math.max(from, Math.min(end, this.size));
        const out = new Uint8Array(to - from);
        let got = 0;
        while (got < out.length) {
            const n = readSync(this.fd, out, got, out.length - got, from + got);
            if (n <= 0) break;
            got += n;
        }
        return got === out.length ? out : out.subarray(0, got);
    }
}
