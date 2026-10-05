/**
 * OLEDLG.DLL - OLE User Interface Support.
 *
 * Ordinal 1 is OleUIAddVerbMenuA — a nine-argument entry point, not the anonymous
 * one-argument dialog stub an undeclared ordinal would be thunked as.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";

export class Oledlg implements IModule {
    name = "oledlg";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        const addVerbMenu: ThunkImplementation = (_ctx, mem, args) => {
            const lpOleObj = args[0] >>> 0;
            const hMenu = args[2] >>> 0;
            const lphMenu = args[8] >>> 0;

            // The API promises NULL when no cascading verb menu was created.  Set
            // it before returning so callers never use an uninitialized handle.
            if (lphMenu && isValidAddress(mem, lphMenu, 4, "rw")) {
                Mem.writeUint32(lphMenu, 0);
            }

            // A real implementation calls IOleObject::EnumVerbs and mutates the
            // guest HMENU.  HLE currently has no synchronous guest COM callback
            // path for that enumeration, so report that no verb was added rather
            // than claiming success or fabricating a menu command.
            Logger.verbose(LogCategory.COM,
                `OleUIAddVerbMenuA(lpOleObj=0x${lpOleObj.toString(16)}, hMenu=0x${hMenu.toString(16)}, lphMenu=0x${lphMenu.toString(16)}) -> FALSE (verb menu unavailable)`);
            return 0; // FALSE
        };

        this.exports["OleUIAddVerbMenuA"] = addVerbMenu;
    }
}
