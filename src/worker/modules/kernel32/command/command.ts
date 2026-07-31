// Command line functions for kernel32
// GetCommandLineA, GetCommandLineW

import { ThunkImplementation } from '../../../core/thunking/thunk-dispatcher';
import { System } from '../../../core/system';
import { encodeAnsi } from '../../codepage-utils';

export const exports: Record<string, ThunkImplementation> = {};

// Command line storage — allocated dynamically from THUNK_DATA
let cmdLineAddrA = 0;
let cmdLineAddrW = 0;
let lastExeName = "";
const CMD_LINE_BUF_SIZE = 2048; // bytes for ANSI
const CMD_LINE_BUF_SIZE_W = 4096; // bytes for wide (2048 chars)

function ensureCommandLineAllocated(): void {
    if (cmdLineAddrA !== 0) return;
    const system = System.getInstance();
    const memory = system.process?.memory;
    if (!memory) return;
    cmdLineAddrA = memory.alloc(CMD_LINE_BUF_SIZE, "THUNK_DATA", "rw");
    cmdLineAddrW = memory.alloc(CMD_LINE_BUF_SIZE_W, "THUNK_DATA", "rw");
}

/** Drop guest command-line buffers — THUNK_DATA is rewound on Process.reset(). */
export function resetCommandLineState(): void {
    cmdLineAddrA = 0;
    cmdLineAddrW = 0;
    lastExeName = "";
}

function initCommandLine(mem: Uint8Array): void {
    const system = System.getInstance();
    const exeName = system.executableName;

    // Only reinitialize if executable name changed
    if (lastExeName === exeName) return;
    lastExeName = exeName;

    ensureCommandLineAllocated();
    if (!cmdLineAddrA || !cmdLineAddrW) return;

    // ANSI version: "exeName args" (Windows GetCommandLineA returns full command line)
    const cmdLineA = system.executableArgs
        ? `${exeName} ${system.executableArgs}`
        : exeName;
    const cmdLineABytes = encodeAnsi(cmdLineA);
    const cmdLineACopy = Math.min(cmdLineABytes.length, CMD_LINE_BUF_SIZE - 1);
    mem.set(cmdLineABytes.subarray(0, cmdLineACopy), cmdLineAddrA);
    mem[cmdLineAddrA + cmdLineACopy] = 0; // null terminator

    // Wide version (UTF-16LE)
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const maxWideChars = (CMD_LINE_BUF_SIZE_W / 2) - 1;
    for (let i = 0; i < cmdLineA.length && i < maxWideChars; i++) {
        view.setUint16(cmdLineAddrW + i * 2, cmdLineA.charCodeAt(i), true);
    }
    view.setUint16(cmdLineAddrW + Math.min(cmdLineA.length, maxWideChars) * 2, 0, true); // null terminator
}

function initCommandFunctions(): void {
    exports['GetCommandLineA'] = (ctx, mem, args): number => {
        initCommandLine(mem);
        return cmdLineAddrA;
    };

    exports['GetCommandLineW'] = (ctx, mem, args): number => {
        initCommandLine(mem);
        return cmdLineAddrW;
    };
}

initCommandFunctions();
