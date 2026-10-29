/**
 * Undo Inno Setup call/jmp compression on executables — port of stream/exefilter.hpp
 * (inno_exe_decoder_4108 and inno_exe_decoder_5200).
 */

import { INNO_VERSION, type InnoVersion } from "./version";

const BLOCK_SIZE = 0x10000;

export interface InnoExeDecoder {
    push(input: Uint8Array): Uint8Array;
    finish(): Uint8Array;
}

/**
 * InstructionFilter4108 — Inno Setup 4.1.8 – 5.1.x. Every E8/E9 operand is rewritten as a
 * byte-serial 32-bit add of -(position + 5); no block boundaries, no high-byte test.
 */
export class InnoExeDecoder4108 implements InnoExeDecoder {
    private addr = 0;
    private addrBytesLeft = 0;
    private addrOffset = 5;

    push(input: Uint8Array): Uint8Array {
        const out = new Uint8Array(input.length);
        for (let i = 0; i < input.length; i++, this.addrOffset = (this.addrOffset + 1) >>> 0) {
            let byte = input[i]!;
            if (this.addrBytesLeft === 0) {
                if (byte === 0xe8 || byte === 0xe9) {
                    this.addr = (~this.addrOffset + 1) >>> 0;
                    this.addrBytesLeft = 4;
                }
            } else {
                this.addr = (this.addr + byte) >>> 0;
                byte = this.addr & 0xff;
                this.addr >>>= 8;
                this.addrBytesLeft--;
            }
            out[i] = byte;
        }
        return out;
    }

    finish(): Uint8Array {
        return new Uint8Array(0);
    }
}

/**
 * InstructionFilter5200 / 5309 — Inno Setup ≥ 5.2.0; the operand's high byte is flipped
 * on a negative result only from 5.3.9 (flip_high_byte).
 */
export class InnoExeDecoder5200 implements InnoExeDecoder {
    constructor(private readonly flipHighByte: boolean) {}

    private offset = 0;
    private flushBytes = 0;
    private buffer = new Uint8Array(4);

    push(input: Uint8Array): Uint8Array {
        const out: number[] = [];
        let i = 0;

        while (i < input.length || this.flushBytes !== 0) {
            if (this.flushBytes > 0 && this.flushBytes <= 4) {
                out.push(this.buffer[4 - this.flushBytes]!);
                this.flushBytes--;
                continue;
            }

            if (this.flushBytes < 0) {
                const need = -this.flushBytes;
                const take = Math.min(need, input.length - i);
                for (let j = 0; j < take; j++) {
                    this.buffer[4 + this.flushBytes + j] = input[i + j]!;
                }
                this.flushBytes += take;
                i += take;
                this.offset += take;
                if (this.flushBytes < 0) break;
                this.applyAddressTransform();
                this.flushBytes = 4;
                continue;
            }

            if (i >= input.length) break;

            const byte = input[i++]!;
            out.push(byte);
            this.offset++;

            if (byte !== 0xe8 && byte !== 0xe9) continue;

            const blockLeft = BLOCK_SIZE - ((this.offset - 1) % BLOCK_SIZE);
            if (blockLeft < 5) continue;

            this.flushBytes = -4;
        }

        return new Uint8Array(out);
    }

    /** Flush trailing call/jmp operand bytes at end of stream — innoextract end-of-stream path. */
    finish(): Uint8Array {
        const out: number[] = [];
        while (this.flushBytes > 0 && this.flushBytes <= 4) {
            out.push(this.buffer[4 - this.flushBytes]!);
            this.flushBytes--;
        }
        return new Uint8Array(out);
    }

    private applyAddressTransform(): void {
        if (this.buffer[3] === 0x00 || this.buffer[3] === 0xff) {
            const addr = this.offset & 0xffffff;
            let rel = this.buffer[0]! | (this.buffer[1]! << 8) | (this.buffer[2]! << 16);
            rel = (rel - addr) >>> 0;
            this.buffer[0] = rel & 0xff;
            this.buffer[1] = (rel >> 8) & 0xff;
            this.buffer[2] = (rel >> 16) & 0xff;
            if (this.flipHighByte && (rel & 0x800000)) {
                this.buffer[3] = (~this.buffer[3]!) & 0xff;
            }
        }
    }
}

/** stream/file.cpp — the filter a data entry's version selects. */
export function createExeDecoder(version: InnoVersion): InnoExeDecoder {
    if (version.value < INNO_VERSION(5, 2, 0)) return new InnoExeDecoder4108();
    return new InnoExeDecoder5200(version.value >= INNO_VERSION(5, 3, 9));
}

/** setup/data.cpp — CallInstructionOptimized (≥ 4.1.8) stored at bit 5 in our flag ladder. */
export function needsExeFilter(options: number): boolean {
    return (options & (1 << 5)) !== 0;
}
