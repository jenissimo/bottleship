/**
 * d3dim700.dll — present so it can be loaded and its exports resolved, as on Windows.
 * Calling one of its private entry points is unsupported and stops the process with the
 * name, rather than returning a value no caller contract defines (see d3dim700.api.ts).
 */
import { IModule } from "../core/module";
import { Process } from "../core/process";
import { System } from "../core/system";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { D3DIM700_EXPORTS } from "../api/d3dim700.api";

export class D3dim700 implements IModule {
    name = "d3dim700";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        for (const name of D3DIM700_EXPORTS) {
            this.exports[name] = (ctx) => {
                System.getInstance().reportGuestCrash({
                    reason: `d3dim700!${name}: private Direct3D 7 runtime entry point is not implemented`,
                    eip: ctx.eip >>> 0,
                });
                return 0;
            };
        }
    }
}
