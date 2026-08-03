/**
 * InitCommonControlsEx - register comctl32 window classes by ICC flag set.
 * Class names and ICC bits follow commctrl.h / comctl32 v6 commctrl.c.
 */

import { Logger, LogCategory } from "../core/logger";
import { registerBuiltinClass } from "./user32/class";
import { ensureAnimateControlClasses } from "./user32/animate-control";

/** sizeof(INITCOMMONCONTROLSEX) - dwSize + dwICC */
export const INITCOMMONCONTROLSEX_SIZE = 8;

export const ICC_LISTVIEW_CLASSES = 0x00000001;
export const ICC_TREEVIEW_CLASSES = 0x00000002;
export const ICC_BAR_CLASSES = 0x00000004;
export const ICC_TAB_CLASSES = 0x00000008;
export const ICC_UPDOWN_CLASS = 0x00000010;
export const ICC_PROGRESS_CLASS = 0x00000020;
export const ICC_HOTKEY_CLASS = 0x00000040;
export const ICC_ANIMATE_CLASS = 0x00000080;
export const ICC_WIN95_CLASSES = 0x000000ff;
export const ICC_DATE_CLASSES = 0x00000100;
export const ICC_USEREX_CLASSES = 0x00000200;
export const ICC_COOL_CLASSES = 0x00000400;
export const ICC_INTERNET_CLASSES = 0x00000800;
export const ICC_PAGESCROLLER_CLASS = 0x00001000;
export const ICC_NATIVEFNTCTL_CLASS = 0x00002000;

/** Known ICC bits for IE 4+ (MFC 4.2 / comctl32 v5 era). */
export const ICC_ALL_VALID = 0x00003fff;

const TOOLTIPS_CLASS = "tooltips_class32";

/** cbWndExtra hints from comctl32 class registration (approximate v5 values). */
const DEFAULT_WND_EXTRA = 4;

function registerClass(
    className: string,
    cbWndExtra = DEFAULT_WND_EXTRA,
    controlClass?: string,
): void {
    registerBuiltinClass(className, { cbWndExtra, controlClass });
}

function registerListViewClasses(): void {
    // controlClass → CreateWindowEx marks isSystemControl (dialog templates already do).
    registerClass("SysListView32", 4, "SysListView32");
    registerClass("SysHeader32", 4, "SysHeader32");
}

function registerTreeViewClasses(): void {
    registerClass("SysTreeView32", 4);
    registerClass(TOOLTIPS_CLASS, 4);
}

function registerBarClasses(): void {
    registerClass("ToolbarWindow32", 4);
    registerClass("msctls_statusbar32", 4);
    registerClass("msctls_trackbar32", 4);
    registerClass(TOOLTIPS_CLASS, 4);
}

function registerTabClasses(): void {
    registerClass("SysTabControl32", 4);
    registerClass(TOOLTIPS_CLASS, 4);
}

function registerUpDownClass(): void {
    registerClass("msctls_updown32", 4);
}

function registerProgressClass(): void {
    registerClass("msctls_progress32", 4);
}

function registerHotKeyClass(): void {
    registerClass("msctls_hotkey32", 4);
}

function registerAnimateClass(): void {
    ensureAnimateControlClasses();
}

function registerDateClasses(): void {
    registerClass("SysDateTimePick32", 4);
    registerClass("SysMonthCal32", 4);
    registerUpDownClass();
}

function registerUserExClasses(): void {
    registerClass("ComboBoxEx32", 4);
}

function registerCoolClasses(): void {
    registerClass("ReBarWindow32", 4);
}

function registerInternetClasses(): void {
    registerClass("SysIPAddress32", 4);
}

function registerPagerClass(): void {
    registerClass("SysPager", 4);
}

function registerNativeFontCtlClass(): void {
    registerClass("NativeFontCtl", 4);
}

/**
 * Register window classes for the requested ICC set. Returns FALSE if dwICC has
 * unknown bits (InitCommonControlsEx contract).
 */
export function initCommonControlsEx(dwICC: number): boolean {
    const flags = dwICC >>> 0;
    if (flags & ~ICC_ALL_VALID) {
        Logger.warn(LogCategory.SYSTEM, `InitCommonControlsEx: invalid dwICC=0x${flags.toString(16)}`);
        return false;
    }
    if (flags === 0) {
        return true;
    }

    if (flags & ICC_LISTVIEW_CLASSES) registerListViewClasses();
    if (flags & ICC_TREEVIEW_CLASSES) registerTreeViewClasses();
    if (flags & ICC_BAR_CLASSES) registerBarClasses();
    if (flags & ICC_TAB_CLASSES) registerTabClasses();
    if (flags & ICC_UPDOWN_CLASS) registerUpDownClass();
    if (flags & ICC_PROGRESS_CLASS) registerProgressClass();
    if (flags & ICC_HOTKEY_CLASS) registerHotKeyClass();
    if (flags & ICC_ANIMATE_CLASS) registerAnimateClass();
    if (flags & ICC_DATE_CLASSES) registerDateClasses();
    if (flags & ICC_USEREX_CLASSES) registerUserExClasses();
    if (flags & ICC_COOL_CLASSES) registerCoolClasses();
    if (flags & ICC_INTERNET_CLASSES) registerInternetClasses();
    if (flags & ICC_PAGESCROLLER_CLASS) registerPagerClass();
    if (flags & ICC_NATIVEFNTCTL_CLASS) registerNativeFontCtlClass();

    Logger.log(LogCategory.SYSTEM, `InitCommonControlsEx: dwICC=0x${flags.toString(16)} registered`);
    return true;
}

/** Legacy InitCommonControls - equivalent to InitCommonControlsEx(ICC_WIN95_CLASSES). */
export function initCommonControls(): boolean {
    return initCommonControlsEx(ICC_WIN95_CLASSES);
}
