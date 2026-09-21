/**
 * MSVCP140 — the VS2015+ C++ standard library.
 *
 * Only the container throw helpers. They are the part a VS2015 binary imports even
 * when it instantiates everything else inline, and they are layout-free, so serving
 * them says nothing about std::basic_string's ABI (which is why this is a module of
 * its own rather than an alias onto msvcp90 — see msvcp140.api.ts).
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Msvcrt } from "./msvcrt";

export class Msvcp140 implements IModule {
    name = "msvcp140";
    exports: Record<string, ThunkImplementation> = {};

    private msvcrt!: Msvcrt;

    setMsvcrt(msvcrt: Msvcrt): void {
        this.msvcrt = msvcrt;
    }

    initialize(_process: Process): void {
        const exports = this.exports;
        /** `void __cdecl std::_X<name>(char const *)` — takes the message, never returns. */
        const withMessage = (exception: string): ThunkImplementation =>
            (_ctx, _mem, args): ThunkResult => this.abort(exception, this.readMessage(args[0] ?? 0));

        exports["?_Xlength_error@std@@YAXPBD@Z"] = withMessage("std::length_error");
        exports["?_Xout_of_range@std@@YAXPBD@Z"] = withMessage("std::out_of_range");
        exports["?_Xinvalid_argument@std@@YAXPBD@Z"] = withMessage("std::invalid_argument");
        exports["?_Xoverflow_error@std@@YAXPBD@Z"] = withMessage("std::overflow_error");
        exports["?_Xruntime_error@std@@YAXPBD@Z"] = withMessage("std::runtime_error");
        exports["?_Xbad_alloc@std@@YAXXZ"] = () => this.abort("std::bad_alloc", "");
    }

    /** The CRT's own reader — it knows the active ANSI code page. */
    private readMessage(ptr: number): string {
        return ptr ? this.msvcrt.readGuestCString(ptr >>> 0, 512) : "";
    }

    /**
     * These helpers are `[[noreturn]]`: they throw, and there is no path back to the
     * caller. We cannot construct a VS2015 exception object (its throw-info and type
     * descriptors live in the caller's image, not ours), so the process ends here —
     * which is where an uncaught container error ends on Windows too. Returning would
     * resume code the compiler proved unreachable.
     */
    private abort(exception: string, message: string): ThunkResult {
        Logger.error(LogCategory.SYSTEM,
            `msvcp140: ${exception} thrown${message ? ` — "${message}"` : ""}; cannot construct the`
            + " VS2015 exception object, terminating");
        return this.msvcrt.terminateGuestProcess(3, `msvcp140: ${exception}`);
    }
}
