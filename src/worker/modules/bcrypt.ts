import type { IModule } from "../core/module";
import type { Process } from "../core/process";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { isValidAddress } from "../core/memory/address-guard";
import { Mem } from "../core/memory/mem-accessor";

const STATUS_INVALID_HANDLE = 0xC0000008;
const STATUS_INVALID_PARAMETER = 0xC000000D;
const BCRYPT_USE_SYSTEM_PREFERRED_RNG = 2;

export class BCrypt implements IModule {
    name = "bcrypt";
    exports: Record<string, ThunkImplementation> = {};
    private readonly random = new Uint8Array(0x10000);

    initialize(_process: Process): void {
        this.exports["BCryptGenRandom"] = (_ctx, mem, args) => {
            const algorithm = args[0] >>> 0;
            const buffer = args[1] >>> 0;
            const count = args[2] >>> 0;
            const flags = args[3] >>> 0;
            if (algorithm || !(flags & BCRYPT_USE_SYSTEM_PREFERRED_RNG)) {
                return { value: STATUS_INVALID_HANDLE, stackCleanup: 16 };
            }
            if ((flags & ~3) || !buffer || buffer + count > mem.length
                || !isValidAddress(mem, buffer, count, "rw")) {
                return { value: STATUS_INVALID_PARAMETER, stackCleanup: 16 };
            }
            // Web Crypto limits each fill to 65536 bytes; the API's ULONG does not.
            for (let offset = 0; offset < count; offset += this.random.length) {
                const chunk = this.random.subarray(0, Math.min(this.random.length, count - offset));
                crypto.getRandomValues(chunk);
                if (Mem.writeBytes(buffer + offset, chunk) !== chunk.length) {
                    return { value: STATUS_INVALID_PARAMETER, stackCleanup: 16 };
                }
            }
            return { value: 0, stackCleanup: 16 };
        };
    }
}
