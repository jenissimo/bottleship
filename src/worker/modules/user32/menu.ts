/**
 * User32 Menu functions
 *
 * Data-only menu model (no rendering) for Win32 menu API compatibility.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { windows } from './shared-state';
import { findResourceInPE } from '../kernel32/resource';
import { encodeAnsi } from '../codepage-utils';
import { System } from '../../core/system';

// Resource types
const RT_MENU = 4;

// Menu flags
const MF_STRING = 0x0000;
const MF_POPUP = 0x0010;
const MF_END = 0x0080;
const MF_SEPARATOR = 0x0800;
const ERROR_MENU_ITEM_NOT_FOUND = 1447;
const MF_CHECKED = 0x0008;
const MF_ENABLED = 0x0000;
const MF_GRAYED = 0x0001;
const MF_DISABLED = 0x0002;
const MF_BYCOMMAND = 0x0000;
const MF_BYPOSITION = 0x0400;
// ChangeMenu (obsolete Win16) operation selectors — the high bits of `flags` pick the op.
const MF_CHANGE = 0x0080;
const MF_APPEND = 0x0100;
const MF_DELETE = 0x0200;
const MF_REMOVE = 0x1000;

interface MenuItem {
    id: number;
    flags: number;
    text: string;
    hSubMenu: number;
}

interface MenuData {
    handle: number;
    isPopup: boolean;
    items: MenuItem[];
}

const menus = new Map<number, MenuData>();
let nextMenuHandle = 0x50000;

// System (window) menu handles per hWnd, created lazily by GetSystemMenu.
const systemMenus = new Map<number, number>();
// Standard system-menu command IDs (WM_SYSCOMMAND).
const SC_SIZE     = 0xF000;
const SC_MOVE     = 0xF010;
const SC_MINIMIZE = 0xF020;
const SC_MAXIMIZE = 0xF030;
const SC_CLOSE    = 0xF060;
const SC_RESTORE  = 0xF120;

function allocMenu(isPopup: boolean): number {
    const handle = nextMenuHandle++;
    menus.set(handle, { handle, isPopup, items: [] });
    return handle;
}

/**
 * Parse a Win32 MENUTEMPLATE (standard version=0) from PE resource data.
 * Returns a populated menu handle.
 */
function parseMenuTemplate(mem: Uint8Array, dataAddr: number, size: number): number {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    // MENUITEMTEMPLATEHEADER
    const versionNumber = view.getUint16(dataAddr, true);
    const offset = view.getUint16(dataAddr + 2, true);

    if (versionNumber !== 0) {
        Logger.warn(LogCategory.USER32, `parseMenuTemplate: unsupported version ${versionNumber}, falling back to empty menu`);
        return allocMenu(false);
    }

    // Items start after header (4 bytes) + offset
    let pos = dataAddr + 4 + offset;
    const endAddr = dataAddr + size;

    const rootMenu = allocMenu(false);

    function parseItems(parentHandle: number): void {
        const parent = menus.get(parentHandle)!;
        while (pos < endAddr) {
            const mtOption = view.getUint16(pos, true);
            pos += 2;

            const isPopup = (mtOption & MF_POPUP) !== 0;
            const isEnd = (mtOption & MF_END) !== 0;

            let mtID = 0;
            if (!isPopup) {
                mtID = view.getUint16(pos, true);
                pos += 2;
            }

            // Read null-terminated UTF-16 string
            let text = '';
            while (pos + 1 < endAddr) {
                const ch = view.getUint16(pos, true);
                pos += 2;
                if (ch === 0) break;
                text += String.fromCharCode(ch);
            }

            const flags = mtOption & ~MF_END;

            if (isPopup) {
                const subHandle = allocMenu(true);
                parseItems(subHandle);
                parent.items.push({
                    id: 0,
                    flags,
                    text,
                    hSubMenu: subHandle,
                });
            } else {
                parent.items.push({
                    id: mtID,
                    flags,
                    text,
                    hSubMenu: 0,
                });
            }

            if (isEnd) break;
        }
    }

    parseItems(rootMenu);

    const rootData = menus.get(rootMenu)!;
    Logger.log(LogCategory.USER32,
        `parseMenuTemplate: parsed ${rootData.items.length} top-level items from resource at 0x${dataAddr.toString(16)}`);

    return rootMenu;
}

function findItem(menu: MenuData, id: number, flags: number): MenuItem | undefined {
    if (flags & MF_BYPOSITION) {
        return menu.items[id];
    }
    return menu.items.find(item => item.id === id);
}

function findItemIndex(menu: MenuData, id: number, flags: number): number {
    if (flags & MF_BYPOSITION) {
        return (id >= 0 && id < menu.items.length) ? id : -1;
    }
    return menu.items.findIndex(item => item.id === id);
}

export function resetMenuState(): void {
    menus.clear();
    nextMenuHandle = 0x50000;
}

export function createMenuExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['CreateMenu'] = (ctx, mem, args) => {
        const handle = allocMenu(false);
        Logger.verbose(LogCategory.USER32, `CreateMenu() -> 0x${handle.toString(16)}`);
        return handle;
    };

    exports['CreatePopupMenu'] = (ctx, mem, args) => {
        const handle = allocMenu(true);
        Logger.verbose(LogCategory.USER32, `CreatePopupMenu() -> 0x${handle.toString(16)}`);
        return handle;
    };

    // BOOL IsMenu(HMENU hMenu)
    // Menu handles are represented by entries in the USER32 menu table; this includes
    // normal menus, popup menus, resource menus, and lazily-created system menus.
    exports['IsMenu'] = (_ctx, _mem, args) => {
        return menus.has(args[0] >>> 0) ? 1 : 0;
    };

    exports['DestroyMenu'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        Logger.verbose(LogCategory.USER32, `DestroyMenu(0x${hMenu.toString(16)})`);
        menus.delete(hMenu);
        return 1;
    };

    // GetSystemMenu(hWnd, bRevert) — return a handle to the window's system (window) menu so the app
    // can modify it (disable Close/Maximize, etc. — common for fullscreen games). bRevert=TRUE resets
    // it and returns NULL. We lazily create one per hWnd, populated with the standard window items.
    exports['GetSystemMenu'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const bRevert = args[1] >>> 0;
        if (bRevert) {
            const existing = systemMenus.get(hWnd);
            if (existing !== undefined) { menus.delete(existing); systemMenus.delete(hWnd); }
            Logger.verbose(LogCategory.USER32, `GetSystemMenu(0x${hWnd.toString(16)}, revert) -> 0`);
            return 0;
        }
        let h = systemMenus.get(hWnd);
        if (h === undefined || !menus.has(h)) {
            h = allocMenu(true);
            const menu = menus.get(h);
            if (menu) {
                menu.items.push(
                    { id: SC_RESTORE,  flags: MF_STRING,    text: 'Restore',  hSubMenu: 0 },
                    { id: SC_MOVE,     flags: MF_STRING,    text: 'Move',     hSubMenu: 0 },
                    { id: SC_SIZE,     flags: MF_STRING,    text: 'Size',     hSubMenu: 0 },
                    { id: SC_MINIMIZE, flags: MF_STRING,    text: 'Minimize', hSubMenu: 0 },
                    { id: SC_MAXIMIZE, flags: MF_STRING,    text: 'Maximize', hSubMenu: 0 },
                    { id: 0,           flags: MF_SEPARATOR, text: '',         hSubMenu: 0 },
                    { id: SC_CLOSE,    flags: MF_STRING,    text: 'Close',    hSubMenu: 0 },
                );
            }
            systemMenus.set(hWnd, h);
        }
        Logger.verbose(LogCategory.USER32, `GetSystemMenu(0x${hWnd.toString(16)}) -> 0x${h.toString(16)}`);
        return h;
    };

    // ChangeMenu - obsolete Win16 API kept for binary compat. The high bits of `flags` select
    // which modern menu op to run; delegate accordingly (matches Wine's user32 mapping).
    // Params: (hMenu, cmd/pos, lpNewItem, cmdInsert/id, flags). Forward refs to the other menu
    // exports resolve at call time (createMenuExports has returned by then).
    exports['ChangeMenuA'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0, pos = args[1] >>> 0, data = args[2] >>> 0, id = args[3] >>> 0, flags = args[4] >>> 0;
        Logger.verbose(LogCategory.USER32, `ChangeMenuA(0x${hMenu.toString(16)}, flags=0x${flags.toString(16)})`);
        if (flags & MF_APPEND) return exports['AppendMenuA']!(ctx, mem, [hMenu, flags & ~MF_APPEND, id, data]);
        if (flags & MF_DELETE) return exports['DeleteMenu']!(ctx, mem, [hMenu, pos, flags & ~MF_DELETE]);
        if (flags & MF_CHANGE) return exports['ModifyMenuA']!(ctx, mem, [hMenu, pos, flags & ~MF_CHANGE, id, data]);
        if (flags & MF_REMOVE) return exports['RemoveMenu']!(ctx, mem, [hMenu, (flags & MF_BYPOSITION) ? pos : id, flags & ~MF_REMOVE]);
        return exports['InsertMenuA']!(ctx, mem, [hMenu, pos, flags, id, data]);
    };

    exports['ChangeMenuW'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0, pos = args[1] >>> 0, data = args[2] >>> 0, id = args[3] >>> 0, flags = args[4] >>> 0;
        Logger.verbose(LogCategory.USER32, `ChangeMenuW(0x${hMenu.toString(16)}, flags=0x${flags.toString(16)})`);
        if (flags & MF_APPEND) return exports['AppendMenuW']!(ctx, mem, [hMenu, flags & ~MF_APPEND, id, data]);
        if (flags & MF_DELETE) return exports['DeleteMenu']!(ctx, mem, [hMenu, pos, flags & ~MF_DELETE]);
        if (flags & MF_CHANGE) return exports['ModifyMenuW']!(ctx, mem, [hMenu, pos, flags & ~MF_CHANGE, id, data]);
        if (flags & MF_REMOVE) return exports['RemoveMenu']!(ctx, mem, [hMenu, (flags & MF_BYPOSITION) ? pos : id, flags & ~MF_REMOVE]);
        return exports['InsertMenuW']!(ctx, mem, [hMenu, pos, flags, id, data]);
    };

    exports['AppendMenuA'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        const uFlags = args[1] >>> 0;
        const uIDNewItem = args[2] >>> 0;
        const lpNewItem = args[3] >>> 0;

        const menu = menus.get(hMenu);
        if (!menu) {
            Logger.warn(LogCategory.USER32, `AppendMenuA: invalid hMenu=0x${hMenu.toString(16)}`);
            return 0;
        }

        let text = '';
        if (!(uFlags & MF_SEPARATOR) && lpNewItem) {
            text = Marshaler.readString(mem, lpNewItem);
        }

        const item: MenuItem = {
            id: uIDNewItem,
            flags: uFlags,
            text,
            hSubMenu: (uFlags & MF_POPUP) ? uIDNewItem : 0,
        };

        menu.items.push(item);
        Logger.verbose(LogCategory.USER32,
            `AppendMenuA(0x${hMenu.toString(16)}, flags=0x${uFlags.toString(16)}, id=${uIDNewItem}, "${text}")`);
        return 1;
    };

    exports['AppendMenuW'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        const uFlags = args[1] >>> 0;
        const uIDNewItem = args[2] >>> 0;
        const lpNewItem = args[3] >>> 0;

        const menu = menus.get(hMenu);
        if (!menu) {
            Logger.warn(LogCategory.USER32, `AppendMenuW: invalid hMenu=0x${hMenu.toString(16)}`);
            return 0;
        }

        let text = '';
        if (!(uFlags & MF_SEPARATOR) && lpNewItem) {
            text = Marshaler.readWideString(mem, lpNewItem);
        }

        const item: MenuItem = {
            id: uIDNewItem,
            flags: uFlags,
            text,
            hSubMenu: (uFlags & MF_POPUP) ? uIDNewItem : 0,
        };

        menu.items.push(item);
        Logger.verbose(LogCategory.USER32,
            `AppendMenuW(0x${hMenu.toString(16)}, flags=0x${uFlags.toString(16)}, id=${uIDNewItem}, "${text}")`);
        return 1;
    };

    exports['GetMenu'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const win = windows.get(hWnd);
        const hMenu = win?.hMenu ?? 0;
        Logger.verbose(LogCategory.USER32, `GetMenu(0x${hWnd.toString(16)}) -> 0x${hMenu.toString(16)}`);
        return hMenu;
    };

    exports['SetMenu'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const hMenu = args[1] >>> 0;
        const win = windows.get(hWnd);
        if (win) {
            win.hMenu = hMenu || undefined;
        }
        Logger.verbose(LogCategory.USER32, `SetMenu(hWnd=0x${hWnd.toString(16)}, hMenu=0x${hMenu.toString(16)})`);
        return 1;
    };

    exports['GetSubMenu'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        const nPos = args[1] | 0;
        const menu = menus.get(hMenu);
        if (!menu || nPos < 0 || nPos >= menu.items.length) {
            Logger.verbose(LogCategory.USER32, `GetSubMenu(0x${hMenu.toString(16)}, ${nPos}) -> 0`);
            return 0;
        }
        const item = menu.items[nPos];
        const sub = item.hSubMenu || 0;
        Logger.verbose(LogCategory.USER32, `GetSubMenu(0x${hMenu.toString(16)}, ${nPos}) -> 0x${sub.toString(16)}`);
        return sub;
    };

    exports['CheckMenuItem'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        const uIDCheckItem = args[1] >>> 0;
        const uCheck = args[2] >>> 0;

        const menu = menus.get(hMenu);
        if (!menu) return 0xFFFFFFFF;

        const item = findItem(menu, uIDCheckItem, uCheck);
        if (!item) return 0xFFFFFFFF;

        const prev = item.flags & MF_CHECKED;
        if (uCheck & MF_CHECKED) {
            item.flags |= MF_CHECKED;
        } else {
            item.flags &= ~MF_CHECKED;
        }
        Logger.verbose(LogCategory.USER32,
            `CheckMenuItem(0x${hMenu.toString(16)}, ${uIDCheckItem}, 0x${uCheck.toString(16)}) prev=${prev}`);
        return prev;
    };

    exports['GetMenuItemCount'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        // Compatibility quirk: some legacy games call GetMenuItemCount(GetMenu(hwnd))
        // without guarding NULL menu handles and expect "no menu" semantics (0 items).
        if (hMenu === 0) {
            Logger.log(LogCategory.USER32, 'GetMenuItemCount(NULL) -> 0 (compat)');
            return 0;
        }

        const menu = menus.get(hMenu);
        if (!menu) {
            Logger.warn(LogCategory.USER32, `GetMenuItemCount: invalid hMenu=0x${hMenu.toString(16)} -> -1`);
            return -1;
        }

        const count = menu.items.length;
        Logger.log(LogCategory.USER32, `GetMenuItemCount(0x${hMenu.toString(16)}) -> ${count}`);
        return count;
    };

    exports['GetMenuState'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        const uId = args[1] >>> 0;
        const uFlags = args[2] >>> 0;
        const menu = menus.get(hMenu);
        if (!menu) return 0xFFFFFFFF;

        const item = findItem(menu, uId, uFlags);
        if (!item) return 0xFFFFFFFF;

        Logger.verbose(LogCategory.USER32,
            `GetMenuState(0x${hMenu.toString(16)}, ${uId}, 0x${uFlags.toString(16)}) -> 0x${item.flags.toString(16)}`);
        return item.flags;
    };

    exports['EnableMenuItem'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        const uIDEnableItem = args[1] >>> 0;
        const uEnable = args[2] >>> 0;
        const menu = menus.get(hMenu);
        if (!menu) return -1;

        const item = findItem(menu, uIDEnableItem, uEnable);
        if (!item) return -1;

        const prev = item.flags & (MF_GRAYED | MF_DISABLED);
        item.flags &= ~(MF_GRAYED | MF_DISABLED);
        item.flags |= (uEnable & (MF_GRAYED | MF_DISABLED));

        Logger.verbose(LogCategory.USER32,
            `EnableMenuItem(0x${hMenu.toString(16)}, ${uIDEnableItem}, 0x${uEnable.toString(16)}) prev=0x${prev.toString(16)}`);
        return prev;
    };

    exports['GetMenuItemID'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        const nPos = args[1] | 0;
        const menu = menus.get(hMenu);
        if (!menu || nPos < 0 || nPos >= menu.items.length) return -1;
        const item = menu.items[nPos];
        if (item.hSubMenu) return -1;
        Logger.verbose(LogCategory.USER32, `GetMenuItemID(0x${hMenu.toString(16)}, ${nPos}) -> ${item.id}`);
        return item.id;
    };

    exports['DrawMenuBar'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        Logger.verbose(LogCategory.USER32, `DrawMenuBar(0x${hWnd.toString(16)})`);
        return 1;
    };

    exports['DeleteMenu'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        const uPosition = args[1] >>> 0;
        const uFlags = args[2] >>> 0;

        const menu = menus.get(hMenu);
        if (!menu) return 0;

        const idx = findItemIndex(menu, uPosition, uFlags);
        Logger.verbose(LogCategory.USER32,
            `DeleteMenu(0x${hMenu.toString(16)}, ${uPosition}, 0x${uFlags.toString(16)}) -> ${idx >= 0}`);
        // FALSE when the item is not there. Stripping a system menu is idiomatically
        // written `while (DeleteMenu(h, 0, MF_BYPOSITION));` — an unconditional TRUE turns that
        // into an infinite loop with no fault and no log to say why.
        if (idx < 0) {
            System.getInstance().scheduler.setLastError(ERROR_MENU_ITEM_NOT_FOUND);
            return 0;
        }
        menu.items.splice(idx, 1);
        return 1;
    };

    exports['RemoveMenu'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        const uPosition = args[1] >>> 0;
        const uFlags = args[2] >>> 0;

        const menu = menus.get(hMenu);
        if (!menu) return 0;

        const idx = findItemIndex(menu, uPosition, uFlags);
        Logger.verbose(LogCategory.USER32,
            `RemoveMenu(0x${hMenu.toString(16)}, ${uPosition}, 0x${uFlags.toString(16)}) -> ${idx >= 0}`);
        // FALSE when the item is not there. Stripping a system menu is idiomatically
        // written `while (RemoveMenu(h, 0, MF_BYPOSITION));` — an unconditional TRUE turns that
        // into an infinite loop with no fault and no log to say why.
        if (idx < 0) {
            System.getInstance().scheduler.setLastError(ERROR_MENU_ITEM_NOT_FOUND);
            return 0;
        }
        menu.items.splice(idx, 1);
        return 1;
    };

    exports['GetMenuStringA'] = (ctx, mem, args) => {
        const hMenu = args[0] >>> 0;
        const uIDItem = args[1] >>> 0;
        const lpString = args[2] >>> 0;
        const cchMax = args[3] | 0;
        const flags = args[4] >>> 0;

        const menu = menus.get(hMenu);
        if (!menu) {
            if (lpString && cchMax > 0) mem[lpString] = 0;
            return 0;
        }

        const item = findItem(menu, uIDItem, flags);
        if (!item) {
            if (lpString && cchMax > 0) mem[lpString] = 0;
            return 0;
        }

        if (lpString && cchMax > 0) {
            const text = item.text;
            const encoded = encodeAnsi(text);
            const writeLen = Math.min(encoded.length, cchMax - 1);
            mem.set(encoded.subarray(0, writeLen), lpString);
            mem[lpString + writeLen] = 0;
            Logger.verbose(LogCategory.USER32,
                `GetMenuStringA(0x${hMenu.toString(16)}, ${uIDItem}) -> "${text.slice(0, writeLen)}"`);
            return writeLen;
        }
        return 0;
    };

    exports['LoadMenuA'] = (ctx, mem, args) => {
        const hInstance = args[0] >>> 0;
        const lpMenuName = args[1] >>> 0;
        const resourceId: number | string = (lpMenuName !== 0 && lpMenuName < 0x10000)
            ? lpMenuName
            : (lpMenuName ? Marshaler.readString(mem, lpMenuName) : '');
        const nameOrId = typeof resourceId === 'number' ? `#${resourceId}` : resourceId;

        const moduleBase = hInstance || 0x00400000;
        const entry = findResourceInPE(mem, moduleBase, RT_MENU, resourceId);
        if (entry) {
            const dataAddr = entry.moduleBase + entry.dataRVA;
            const handle = parseMenuTemplate(mem, dataAddr, entry.size);
            Logger.log(LogCategory.USER32, `LoadMenuA(0x${hInstance.toString(16)}, "${nameOrId}") -> 0x${handle.toString(16)} (${menus.get(handle)?.items.length ?? 0} items from PE)`);
            return handle;
        }

        const handle = allocMenu(false);
        Logger.warn(LogCategory.USER32, `LoadMenuA(0x${hInstance.toString(16)}, "${nameOrId}") -> 0x${handle.toString(16)} (empty, resource not found)`);
        return handle;
    };

    exports['LoadMenuW'] = (ctx, mem, args) => {
        const hInstance = args[0] >>> 0;
        const lpMenuName = args[1] >>> 0;
        const resourceId: number | string = (lpMenuName !== 0 && lpMenuName < 0x10000)
            ? lpMenuName
            : (lpMenuName ? Marshaler.readWideString(mem, lpMenuName) : '');
        const nameOrId = typeof resourceId === 'number' ? `#${resourceId}` : resourceId;

        const moduleBase = hInstance || 0x00400000;
        const entry = findResourceInPE(mem, moduleBase, RT_MENU, resourceId);
        if (entry) {
            const dataAddr = entry.moduleBase + entry.dataRVA;
            const handle = parseMenuTemplate(mem, dataAddr, entry.size);
            Logger.log(LogCategory.USER32, `LoadMenuW(0x${hInstance.toString(16)}, "${nameOrId}") -> 0x${handle.toString(16)} (${menus.get(handle)?.items.length ?? 0} items from PE)`);
            return handle;
        }

        const handle = allocMenu(false);
        Logger.warn(LogCategory.USER32, `LoadMenuW(0x${hInstance.toString(16)}, "${nameOrId}") -> 0x${handle.toString(16)} (empty, resource not found)`);
        return handle;
    };

    exports['SetMenuItemBitmaps'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `SetMenuItemBitmaps(...) -> stub`);
        return 1;
    };

    exports['GetMenuCheckMarkDimensions'] = (ctx, mem, args) => {
        return (13 << 16) | 13;
    };

    exports['GetMenuItemInfoA'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `GetMenuItemInfoA(...) -> stub`);
        return 1;
    };

    exports['GetMenuItemInfoW'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `GetMenuItemInfoW(...) -> stub`);
        return 1;
    };

    exports['SetMenuItemInfoA'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `SetMenuItemInfoA(...) -> stub`);
        return 1;
    };

    exports['SetMenuItemInfoW'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `SetMenuItemInfoW(...) -> stub`);
        return 1;
    };

    exports['ModifyMenuA'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `ModifyMenuA(...) -> stub`);
        return 1;
    };

    exports['ModifyMenuW'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `ModifyMenuW(...) -> stub`);
        return 1;
    };

    exports['InsertMenuA'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `InsertMenuA(...) -> stub`);
        return 1;
    };

    exports['InsertMenuW'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `InsertMenuW(...) -> stub`);
        return 1;
    };

    exports['TrackPopupMenu'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `TrackPopupMenu(...) -> stub`);
        return 0;
    };

    exports['TrackPopupMenuEx'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `TrackPopupMenuEx(...) -> stub`);
        return 0;
    };

    exports['SetMenuInfo'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `SetMenuInfo(...) -> stub`);
        return 1;
    };

    exports['GetMenuInfo'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `GetMenuInfo(...) -> stub`);
        return 1;
    };

    return exports;
}
