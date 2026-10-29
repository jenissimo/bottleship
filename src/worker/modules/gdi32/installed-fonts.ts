/**
 * The fonts a Windows install has in %windir%\Fonts are available to every process by
 * face name without an AddFontResource call — an installer that copies its faces there
 * relies on it. Register them once at boot, as Windows does when it starts.
 */
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { addFontResource, resetFontResources } from "./font-resource";

const FONTS_DIR = "C:\\WINDOWS\\Fonts";
const FONT_FILE = /\.(ttf|otf|ttc)$/i;
const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;

export async function installWindowsFonts(): Promise<number> {
    resetFontResources();
    const vfs = System.getInstance().fileSystem;
    let entries;
    try {
        entries = vfs.listDirectory(FONTS_DIR);
    } catch {
        return 0;
    }
    let installed = 0;
    for (const entry of entries) {
        if (entry.kind !== "file" || !FONT_FILE.test(entry.name) || entry.size <= 0) continue;
        const path = `${FONTS_DIR}\\${entry.name}`;
        try {
            const handle = await vfs.open(path, GENERIC_READ, OPEN_EXISTING);
            if (!handle) continue;
            installed += await addFontResource(vfs.resolvePath(path), await vfs.read(handle, entry.size), 0);
        } catch (e) {
            Logger.warn(LogCategory.GDI32, `installWindowsFonts: "${path}" failed: ${e}`);
        }
    }
    if (installed) Logger.log(LogCategory.GDI32, `installWindowsFonts: ${installed} font(s) from ${FONTS_DIR}`);
    return installed;
}
