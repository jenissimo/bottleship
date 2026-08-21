/**
 * SHFOLDER.dll — the redistributable forwarder Microsoft shipped so pre-Win2000 titles could
 * call SHGetFolderPath without linking shell32 directly. Every export is the shell32 one.
 *
 * It exists as a real module rather than relying on the dispatcher's shfolder>shell32 forward
 * because that forward can only bind once a shell32 stub of the same name has been generated:
 * a title that loads shfolder alone gets no handler, and its save-path lookup fails.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { createFolderPathExports } from "./shell32";

export class Shfolder implements IModule {
    name = "shfolder";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        Object.assign(this.exports, createFolderPathExports());
    }
}
