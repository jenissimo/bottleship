/**
 * COMDLG32.dll - Common Dialog Box Library
 *
 * Provides standard Windows dialogs: file open/save, print, find/replace, color/font pickers.
 * Most dialogs are stubbed to return FALSE (user cancelled), except GetFileTitleA which extracts filename.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Marshaler } from "../core/memory/marshaler";
import { savestateParticipants, savestatesEnabled, stateKeys, type FieldPolicy } from "../savestate/participant";
import { CaptureRefusal } from "../savestate/object-codecs";
import type { SaveValue } from "../savestate/value-codec";

export const COMDLG32_FIELDS = {
    name: 'transient', exports: 'host', lastError: 'save',
} as const satisfies Record<string, FieldPolicy>;

export interface Comdlg32State {
    lastError: number;
}

export const COMDLG32_SCHEMA = {
    module: COMDLG32_FIELDS,
    state: stateKeys<Comdlg32State>({ lastError: true }),
};

export class Comdlg32 implements IModule {
    name = "comdlg32";
    exports: Record<string, ThunkImplementation> = {};

    private lastError: number = 0;  // 0 = no error

    captureSavestate(): Comdlg32State {
        return { lastError: this.lastError };
    }

    restoreSavestate(s: Comdlg32State): void {
        this.lastError = s.lastError;
    }

    registerSavestate(): () => void {
        return savestateParticipants.add({
            id: 'comdlg32', version: 1, order: 71, covers: ['comdlg32'], schema: COMDLG32_SCHEMA as unknown as SaveValue,
            capture: () => {
                try {
                    return this.captureSavestate() as unknown as SaveValue;
                } catch (e) {
                    throw e instanceof CaptureRefusal ? e : new CaptureRefusal(e instanceof Error ? e.message : String(e));
                }
            },
            restore: (saved) => this.restoreSavestate(saved as unknown as Comdlg32State),
        });
    }

    initialize(_process: Process): void {
        if (savestatesEnabled()) this.registerSavestate();
        // File open/save dialogs - return FALSE (user cancelled)
        this.exports["GetOpenFileNameA"] = this.stubDialog("GetOpenFileNameA");
        this.exports["GetOpenFileNameW"] = this.stubDialog("GetOpenFileNameW");
        this.exports["GetSaveFileNameA"] = this.stubDialog("GetSaveFileNameA");
        this.exports["GetSaveFileNameW"] = this.stubDialog("GetSaveFileNameW");

        // Extract filename from path
        this.exports["GetFileTitleA"] = (ctx, mem, args) => {
            const lpszFile = args[0];
            const lpszTitle = args[1];
            const cbBuf = args[2];

            if (!lpszFile || !lpszTitle || cbBuf === 0) {
                Logger.verbose(LogCategory.SYSTEM, `GetFileTitleA: invalid params`);
                return -1; // Error
            }

            const fullPath = Marshaler.readString(mem, lpszFile);
            const filename = fullPath.split(/[/\\]/).pop() || "";

            // Copy filename to buffer (without extension if cbBuf is small)
            const toCopy = filename.substring(0, Math.min(filename.length, cbBuf - 1));
            Marshaler.writeString(mem, lpszTitle, toCopy);

            Logger.verbose(LogCategory.SYSTEM, `GetFileTitleA: "${fullPath}" -> "${toCopy}"`);
            return 0; // Success
        };

        this.exports["GetFileTitleW"] = (ctx, mem, args) => {
            const lpszFile = args[0];
            const lpszTitle = args[1];
            const cbBuf = args[2];

            if (!lpszFile || !lpszTitle || cbBuf === 0) {
                Logger.verbose(LogCategory.SYSTEM, `GetFileTitleW: invalid params`);
                return -1; // Error
            }

            const fullPath = Marshaler.readWideString(mem, lpszFile);
            const filename = fullPath.split(/[/\\]/).pop() || "";

            const toCopy = filename.substring(0, Math.min(filename.length, cbBuf - 1));
            Marshaler.writeWideString(mem, lpszTitle, toCopy);

            Logger.verbose(LogCategory.SYSTEM, `GetFileTitleW: "${fullPath}" -> "${toCopy}"`);
            return 0; // Success
        };

        // Find/Replace text dialogs - return NULL (dialog not created)
        this.exports["FindTextA"] = this.stubDialogHandle("FindTextA");
        this.exports["FindTextW"] = this.stubDialogHandle("FindTextW");
        this.exports["ReplaceTextA"] = this.stubDialogHandle("ReplaceTextA");
        this.exports["ReplaceTextW"] = this.stubDialogHandle("ReplaceTextW");

        // Print dialog - return FALSE (user cancelled)
        this.exports["PrintDlgA"] = this.stubDialog("PrintDlgA");
        this.exports["PrintDlgW"] = this.stubDialog("PrintDlgW");
        this.exports["PrintDlgExA"] = this.stubDialog("PrintDlgExA");
        this.exports["PrintDlgExW"] = this.stubDialog("PrintDlgExW");

        // Color picker - return FALSE (user cancelled)
        this.exports["ChooseColorA"] = this.stubDialog("ChooseColorA");
        this.exports["ChooseColorW"] = this.stubDialog("ChooseColorW");

        // Font picker - return FALSE (user cancelled)
        this.exports["ChooseFontA"] = this.stubDialog("ChooseFontA");
        this.exports["ChooseFontW"] = this.stubDialog("ChooseFontW");

        // Error handling
        this.exports["CommDlgExtendedError"] = (ctx, mem, args) => {
            const err = this.lastError;
            Logger.verbose(LogCategory.SYSTEM, `CommDlgExtendedError: ${err}`);
            return err;
        };
    }

    reset(): void {
        this.lastError = 0;
    }

    /**
     * Stub for dialog functions that return BOOL (TRUE/FALSE).
     * Returns FALSE (0) to indicate user cancelled the dialog.
     */
    private stubDialog(name: string): ThunkImplementation {
        return (ctx, mem, args) => {
            const lpStruct = args[0];
            Logger.verbose(LogCategory.SYSTEM, `${name}(0x${lpStruct.toString(16)}): stubbed (user cancelled)`);
            this.lastError = 0; // No error, just cancelled
            return 0; // FALSE - user cancelled
        };
    }

    /**
     * Stub for dialog functions that return HWND (window handle).
     * Returns NULL (0) to indicate dialog not created.
     */
    private stubDialogHandle(name: string): ThunkImplementation {
        return (ctx, mem, args) => {
            const lpStruct = args[0];
            Logger.verbose(LogCategory.SYSTEM, `${name}(0x${lpStruct.toString(16)}): stubbed (not implemented)`);
            this.lastError = 0; // No error
            return 0; // NULL - dialog not created
        };
    }
}
