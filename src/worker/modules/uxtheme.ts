/**
 * UXTHEME.dll stubs.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";

const S_OK = 0;

export class Uxtheme implements IModule {
    name = "uxtheme";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        // BottleShip does not provide native visual styles.  Still expose the
        // capability probes: applications commonly call them after a successful
        // LoadLibrary/GetProcAddress sequence and expect FALSE when themes are off.
        // Omitting the exports leaves a null function pointer in such callers.
        this.exports["IsThemeActive"] = () => 0;
        this.exports["IsAppThemed"] = () => 0;

        // void SetThemeAppProperties(DWORD dwFlags)
        this.exports["SetThemeAppProperties"] = (ctx, mem, args) => {
            const flags = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `uxtheme:SetThemeAppProperties(flags=0x${flags.toString(16)})`);
            return S_OK;
        };
    }

    reset(): void {}
}
