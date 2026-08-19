/**
 * NetAPI32 — no NetBIOS/LAN redirector; games fall back to TCP/IP paths.
 * The workstation-info calls are answered for real, because the usual caller is a
 * fingerprint/licence check that treats a failure as "cannot identify this machine".
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { GUEST_COMPUTER_NAME, GUEST_WORKGROUP_NAME } from "../core/guest-identity";

// NRC_ENVNOTDEF — NetBIOS environment not defined (no redirector loaded)
const NRC_ENVNOTDEF = 0x05;

const NERR_Success = 0;
const ERROR_INVALID_LEVEL = 124;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** lmcons.h PLATFORM_ID_NT / PLATFORM_ID_DOS. */
const PLATFORM_ID_DOS = 300;
const PLATFORM_ID_NT = 500;
const VER_PLATFORM_WIN32_NT = 2;

/**
 * WKSTA_INFO_100: +0 platform_id +4 computername(LPWSTR) +8 langroup(LPWSTR)
 *                 +12 ver_major +16 ver_minor                      (20 bytes)
 * WKSTA_INFO_101 adds +20 lanroot(LPWSTR)                          (24 bytes)
 * WKSTA_INFO_102 adds +24 logged_on_users                          (28 bytes)
 * Every string points INTO the same NetApiBufferAllocate block, which the caller
 * releases with one NetApiBufferFree of the struct pointer.
 */
const WKSTA_INFO_SIZE: Record<number, number> = { 100: 20, 101: 24, 102: 28 };

export class Netapi32 implements IModule {
    name = "netapi32";
    exports: Record<string, ThunkImplementation> = {};

    /** Game switch: the addresses in `allocated` belong to the old address space. */
    reset(): void { this.resetAllocated?.(); }

    private resetAllocated: (() => void) | null = null;

    initialize(process: Process): void {
        /** Blocks handed out by a Net*GetInfo, keyed by the pointer the caller received. */
        const allocated = new Set<number>();
        this.resetAllocated = () => allocated.clear();

        // UCHAR NETBIOSAPI Netbios(PNCB pncb)
        this.exports["Netbios"] = (_ctx, _mem, args) => {
            const pncb = args[0] >>> 0;
            if (pncb) Mem.writeUint8(pncb + 1, NRC_ENVNOTDEF); // ncb_retcode
            return NRC_ENVNOTDEF;
        };

        // NET_API_STATUS NetWkstaGetInfo(LMSTR servername, DWORD level, LPBYTE *bufptr)
        this.exports["NetWkstaGetInfo"] = (_ctx, _mem, args) => {
            const level = args[1] >>> 0;
            const bufptr = args[2] >>> 0;
            const structSize = WKSTA_INFO_SIZE[level];
            if (!structSize) return ERROR_INVALID_LEVEL;
            if (!bufptr) return ERROR_NOT_ENOUGH_MEMORY;

            const name = GUEST_COMPUTER_NAME;
            const group = GUEST_WORKGROUP_NAME;
            // Strings live after the struct in one block, UTF-16 with terminators.
            const nameOff = structSize;
            const groupOff = nameOff + (name.length + 1) * 2;
            const total = groupOff + (group.length + 1) * 2;

            const block = process.memory.alloc(total, "THUNK_DATA", "rw");
            if (!block) return ERROR_NOT_ENOUGH_MEMORY;

            const writeWide = (at: number, text: string): boolean => {
                for (let i = 0; i < text.length; i++) {
                    if (!Mem.writeUint16(at + i * 2, text.charCodeAt(i))) return false;
                }
                return Mem.writeUint16(at + text.length * 2, 0);
            };

            const { major, minor, platformId } = EmulatorConfig.getInstance().osVersion;
            const ok = Mem.writeUint32(block, platformId === VER_PLATFORM_WIN32_NT ? PLATFORM_ID_NT : PLATFORM_ID_DOS)
                && Mem.writeUint32(block + 4, block + nameOff)
                && Mem.writeUint32(block + 8, block + groupOff)
                && Mem.writeUint32(block + 12, major)
                && Mem.writeUint32(block + 16, minor)
                && writeWide(block + nameOff, name)
                && writeWide(block + groupOff, group);
            // No network redirector, so there is no LAN root and nobody is logged on over it.
            const okExtra = (level < 101 || Mem.writeUint32(block + 20, 0))
                && (level < 102 || Mem.writeUint32(block + 24, 0));
            if (!ok || !okExtra) {
                process.memory.free(block);
                return ERROR_NOT_ENOUGH_MEMORY;
            }

            if (!Mem.writeUint32(bufptr, block >>> 0)) {
                process.memory.free(block);
                return ERROR_NOT_ENOUGH_MEMORY;
            }
            allocated.add(block >>> 0);
            return NERR_Success;
        };

        // NET_API_STATUS NetApiBufferFree(LPVOID Buffer)
        // NULL is explicitly legal, and a pointer we never handed out is ignored rather
        // than passed to the allocator — freeing a foreign block would corrupt the heap.
        this.exports["NetApiBufferFree"] = (_ctx, _mem, args) => {
            const buffer = args[0] >>> 0;
            if (buffer && allocated.delete(buffer)) process.memory.free(buffer);
            return NERR_Success;
        };
    }
}
