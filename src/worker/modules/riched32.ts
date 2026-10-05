/**
 * RICHED32.dll — Rich Edit 1.x loader.
 *
 * Real RICHED32 registers RICHEDIT / RichEdit20* window classes in DllMain.
 * We register the same built-in classes at init so LoadLibrary + CreateWindow works.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { registerBuiltinClass } from "./user32/class";
import { getSystemCursorHandle, IDC_IBEAM } from "./user32/system-cursors";

const S_FALSE = 1;
const E_NOTIMPL = 0x80004001;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111;

function registerRichEditClasses(): void {
    // controlClass is what makes CreateWindowEx mark the window a JS system control,
    // so the EM_* protocol and the default chrome come from rich-edit-control.ts —
    // without it these windows have no behavior and no appearance at all.
    const common = { controlClass: "RichEdit", hCursor: getSystemCursorHandle(IDC_IBEAM) };
    // Rich Edit 1.0 (RICHED32.DLL)
    registerBuiltinClass("RICHEDIT", { cbWndExtra: 4, ...common });
    // Rich Edit 2.0+ class names (normally riched20.dll; games expect them after RICHED32 load)
    registerBuiltinClass("RichEdit20A", { cbWndExtra: 256, ...common });
    registerBuiltinClass("RichEdit20W", { cbWndExtra: 256, ...common });
    // Legacy alias seen in some resources
    registerBuiltinClass("RichEdit", { cbWndExtra: 256, ...common });
}

export class Riched32 implements IModule {
    name = "riched32";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        registerRichEditClasses();

        // HRESULT CreateTextServices(IUnknown* punkOuter, ITextHost* pITextHost, IUnknown** ppUnk)
        // Full TSF/COM text services are not emulated; callers using CreateWindow are unaffected.
        this.exports["CreateTextServices"] = (ctx, mem, args) => {
            const ppUnk = args[2] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `riched32:CreateTextServices(punkOuter=0x${(args[0] >>> 0).toString(16)}, host=0x${(args[1] >>> 0).toString(16)}, ppUnk=0x${ppUnk.toString(16)}) -> E_NOTIMPL`
            );
            if (ppUnk) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ppUnk, 0, true);
            }
            return E_NOTIMPL;
        };

        this.exports["DllGetClassObject"] = () => {
            Logger.verbose(LogCategory.SYSTEM, "riched32:DllGetClassObject -> CLASS_E_CLASSNOTAVAILABLE");
            return CLASS_E_CLASSNOTAVAILABLE;
        };

        this.exports["DllCanUnloadNow"] = () => S_FALSE;
    }

    reset(): void {
        registerRichEditClasses();
    }
}
