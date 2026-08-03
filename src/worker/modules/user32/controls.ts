/**
 * System control rendering for Win32 dialog controls.
 *
 * Draws directly onto the overlay canvas context obtained from the provided HDC.
 * Called from EndPaint after the parent window has finished its own painting,
 * so controls are composited on top of the dialog background.
 */

import { System } from '../../core/system';
import { windows, isEffectivelyVisible, buttonCheckStates, listControlStates, controlImageHandles, getOrCreateTrackbarState, getChildrenInPaintOrder, getAbsoluteWindowPosition, getAncestorClipRect, isFullyCoveredByGuestChild } from './shared-state';
import type { GDIContext } from '../gdi32/context';
import type { WindowInfo } from './shared-state';
import { resolveBitmapRgba, resolveIconRgba, layoutStaticControlImage, blitStaticControlImage } from '../gdi32/bitmap-resolve';
import { Logger, LogCategory } from '../../core/logger';
import { fillTextWithMnemonic, measureMnemonicText } from '../win32-text';
import { getEditVisualState, EDIT_TEXT_INSET } from './edit-control';
import { getControlColorOverride } from './control-colors';
import {
    getListViewState,
    clampListViewTopIndex,
    listViewHasHeader,
    listViewRowHeight,
    listViewViewStyle,
    listViewVisibleCount,
    LV_HEADER_H,
    LV_ICON_SIZE,
    LV_SMALL_ICON_SIZE,
    LV_ICON_PAD,
    LV_TEXT_INSET,
    LV_SCROLLBAR_W,
    LVIS_SELECTED,
    LVIS_FOCUSED,
    LVS_ICON,
    LVS_REPORT,
    LVS_SMALLICON,
    LVS_LIST,
    LVS_SHOWSELALWAYS,
} from './list-view-control';

// Window styles
const WS_DISABLED = 0x08000000;

// BST_* values
const BST_UNCHECKED = 0;
const BST_CHECKED = 1;
const BST_INDETERMINATE = 2;
const BST_PUSHED = 4;

// BS_* styles (low nibble)
const BS_TYPEMASK = 0x000F;
const BS_PUSHBUTTON = 0x0000;
const BS_DEFPUSHBUTTON = 0x0001;
const BS_CHECKBOX = 0x0002;
const BS_AUTOCHECKBOX = 0x0003;
const BS_RADIOBUTTON = 0x0004;
const BS_3STATE = 0x0005;
const BS_AUTO3STATE = 0x0006;
const BS_GROUPBOX = 0x0007;
const BS_AUTORADIOBUTTON = 0x0009;
const BS_BITMAP = 0x0080;
const BS_OWNERDRAW = 0x000B;

// SS_* styles
const SS_TYPEMASK = 0x001F;
const SS_LEFT = 0x0000;
const SS_CENTER = 0x0001;
const SS_RIGHT = 0x0002;
const SS_ICON = 0x0003;
const SS_BLACKRECT = 0x0004;
const SS_GRAYRECT = 0x0005;
const SS_WHITERECT = 0x0006;
const SS_BLACKFRAME = 0x0007;
const SS_GRAYFRAME = 0x0008;
const SS_WHITEFRAME = 0x0009;
const SS_SIMPLE = 0x000B;
const SS_LEFTNOWORDWRAP = 0x000C;
const SS_BITMAP = 0x000E;
const SS_ETCHEDHORZ = 0x0010;
const SS_ETCHEDVERT = 0x0011;
const SS_ETCHEDFRAME = 0x0012;
const SS_CENTERIMAGE = 0x0200;
const SS_NOPREFIX = 0x0080;
const SS_REALSIZEIMAGE = 0x0800;

// SBS_* styles
const SBS_VERT = 0x0001;

// Windows classic theme colors
const COLOR_BTNFACE = '#D4D0C8';
const COLOR_BTNHILIGHT = '#FFFFFF';
const COLOR_BTNINNERHI = '#DFDFDF';
const COLOR_BTNSHADOW = '#808080';
const COLOR_BTNDKSHADOW = '#404040';
const COLOR_WINDOW = '#FFFFFF';
const COLOR_WINDOWTEXT = '#000000';
const COLOR_BTNTEXT = '#000000';
const COLOR_GRAYTEXT = '#808080';
const COLOR_HIGHLIGHT = '#0A246A';
const COLOR_HIGHLIGHTTEXT = '#FFFFFF';

// Font used for control labels
const CONTROL_FONT = "11px 'Liberation Sans', sans-serif";

function getWindowFont(win: WindowInfo): string {
    const parent = win.parent !== undefined ? windows.get(win.parent) : undefined;
    const hFont = win.fontHandle || parent?.fontHandle || 0;
    if (!hFont) return CONTROL_FONT;
    return System.getInstance().gdiContext.getFontCss(hFont) ?? CONTROL_FONT;
}

/**
 * Paint all visible system child controls of the given parent window.
 * hdc must be a valid HDC pointing at the overlay canvas (as returned by BeginPaint).
 *
 * The dialog background is painted separately via WM_ERASEBKGND in DefDlgProcA,
 * which runs BEFORE the game's WM_PAINT. This function must NOT re-fill the background
 * because that would overwrite text the game drew in WM_PAINT.
 */
export function paintChildControls(parentHwnd: number, hdc: number, gdi: GDIContext): void {
    const parent = windows.get(parentHwnd);
    if (!parent || !parent.children.length) return;
    // Never paint the controls of a hidden window. A dialog created hidden gets its
    // content messages (LB_ADDSTRING, TBM_SETPOS, …) during WM_INITDIALOG, BEFORE
    // ShowWindow positions it — painting then stamps controls at the stale pre-move
    // origin into the persistent overlay (ghost). ShowWindow repaints once visible.
    // Ancestor-aware: a closed splash dialog keeps its children's WS_VISIBLE bit, and
    // repainting them re-stamps a splash that EndDialog already erased.
    if (!isEffectivelyVisible(parent)) return;

    const ctx = gdi.getDC(hdc);
    if (!ctx) return;

    // child.x, child.y are parent-client-relative coordinates.
    // parent.x, parent.y give the parent's top-left in canvas (screen) space.
    const parentAbsX = getChainX(parent);
    const parentAbsY = getChainY(parent);

    // Win32 clips these controls to every ancestor's client area (see
    // getAncestorClipRect); the flat overlay has no per-window clip of its own.
    const clip = getAncestorClipRect(parent);
    if (clip && (clip.w <= 0 || clip.h <= 0)) return;
    if (clip) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
    }

    let painted = false;
    for (const childHandle of getChildrenInPaintOrder(parentHwnd)) {
        const child = windows.get(childHandle);
        if (!child || !child.visible || !child.isSystemControl) continue;
        // Skip default chrome only for a control that has DEMONSTRABLY painted itself
        // (its own EndPaint flushed pixels — child.guestCustomPaint). Subclassing alone is
        // not that claim: MFC's DDX_Control/SubclassDlgItem and UE1's WControl wrap a
        // control purely for message routing and leave WM_PAINT to the original class proc,
        // which IS this chrome. Assuming "subclassed ⇒ guest paints it" left such controls
        // permanently blank (UE1's video-options resolution ListBox: items inserted, nothing
        // drawn). Chrome is painted BEFORE the guest-paint chain runs, so a control the guest
        // really does draw still wins — it simply overwrites what we put down.
        if (child.guestCustomPaint && !isButtonSystemControl(child) && parent.guestCustomPaint
            && !controlImageHandles.has(child.handle)) continue;

        painted = paintSystemControl(child, hdc, gdi, parentAbsX, parentAbsY) || painted;
    }

    if (clip) ctx.restore();

    // Open combobox dropdowns paint LAST (topmost among siblings) and OUTSIDE the
    // ancestor clip — Win32's drop-down list is its own ComboLBox popup, free to
    // extend past the parent that owns the closed box.
    for (const childHandle of getChildrenInPaintOrder(parentHwnd)) {
        const child = windows.get(childHandle);
        if (!child || !child.visible || !child.isSystemControl) continue;
        if (normalizeSystemControlClass(child.systemControlClass) !== 'combobox') continue;
        if (!listControlStates.get(child.handle)?.dropdownOpen) continue;
        paintComboDropdown(ctx, child);
        painted = true;
    }

    // Only mark dirty if at least one system control was actually painted
    if (painted) {
        gdi.setOverlayDirty(true);
    }
}

export function paintSystemControl(
    child: WindowInfo,
    hdc: number,
    gdi: GDIContext,
    parentAbsX?: number,
    parentAbsY?: number,
): boolean {
    if (!isEffectivelyVisible(child) || !child.isSystemControl) return false;
    const parent = child.parent !== undefined ? windows.get(child.parent) : undefined;
    // See paintChildControls: defer only to a control that has actually painted itself.
    if (child.guestCustomPaint && !isButtonSystemControl(child) && parent?.guestCustomPaint
        && !controlImageHandles.has(child.handle)) return false;
    const ctx = gdi.getDC(hdc);
    if (!ctx) return false;

    const baseX = parentAbsX ?? (parent ? getChainX(parent) : 0);
    const baseY = parentAbsY ?? (parent ? getChainY(parent) : 0);
    const absX = baseX + child.x;
    const absY = baseY + child.y;
    const w = Math.max(1, child.width);
    const h = Math.max(1, child.height);
    const controlClass = normalizeSystemControlClass(child.systemControlClass);

    // A caller that passed parentAbs* is painting a batch and has already clipped to
    // the ancestor chain (paintChildControls); a standalone repaint must do it itself,
    // with the SAME rect (the parent's ancestors, not the parent) so a full repaint and
    // a single-control repaint cannot disagree about what is clipped.
    const clip = parentAbsX === undefined && parent ? getAncestorClipRect(parent) : null;
    if (clip) {
        if (clip.w <= 0 || clip.h <= 0) return false;
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
    }

    switch (controlClass) {
        case 'button':
            paintButton(ctx, child, absX, absY, w, h);
            break;
        case 'static':
            paintStatic(ctx, child, absX, absY, w, h);
            break;
        case 'sysanimate32':
        case 'sysanimate32_class':
            if (clip) ctx.restore();
            return false;
        case 'edit':
            paintEdit(ctx, child, absX, absY, w, h);
            break;
        case 'combobox':
            paintComboBox(ctx, child, absX, absY, w, h);
            break;
        case 'listbox':
            paintListBox(ctx, child, absX, absY, w, h);
            break;
        case 'syslistview32':
            paintListView(ctx, child, absX, absY, w, h);
            break;
        case 'scrollbar':
            paintScrollBar(ctx, child, absX, absY, w, h);
            break;
        case 'msctls_trackbar32':
            paintTrackbar(ctx, child, absX, absY, w, h);
            break;
        case 'msctls_progress32':
            paintProgressBar(ctx, child, absX, absY, w, h);
            break;
        default:
            paintGenericControl(ctx, child, absX, absY, w, h);
            break;
    }

    if (clip) ctx.restore();
    gdi.setOverlayDirty(true);
    return true;
}

export function isButtonSystemControl(win: WindowInfo | undefined): boolean {
    return normalizeSystemControlClass(win?.systemControlClass) === 'button';
}

/**
 * Real Windows' Button class answers WM_NCHITTEST with HTTRANSPARENT for
 * BS_GROUPBOX — a group box never captures mouse input; clicks fall through to
 * whatever's underneath. Dialog templates routinely list a group box AFTER the
 * controls it visually contains (creation order = initial z-order, so the box
 * would otherwise sit "on top" and intercept clicks meant for the control inside
 * it — e.g. TLJ's ComboBox/CheckBox controls precede their enclosing group box).
 * Every hit-test walk must skip group boxes the same way, or every control
 * nested inside one becomes unclickable purely from template ordering.
 */
export function isGroupBoxSystemControl(win: WindowInfo | undefined): boolean {
    return isButtonSystemControl(win) && ((win!.style & BS_TYPEMASK) === BS_GROUPBOX);
}

/** Walk up the parent chain summing x offsets (canvas space). */
// getChainX/Y/Abs must match getAbsoluteWindowPosition exactly: only a WS_CHILD window's
// (x,y) is parent-client-relative, so the walk stops at the first top-level (WS_POPUP)
// ancestor whose position is already screen-absolute. Delegating keeps that one rule in one
// place — a private copy that blindly summed every ancestor pushed a centered #32770's child
// CONTROLS to the owner's origin while the dialog frame sat centered (Airfix launcher split).
function getChainX(win: WindowInfo): number {
    return getAbsoluteWindowPosition(win).x;
}

/** Walk up the parent chain summing y offsets (canvas space). */
function getChainY(win: WindowInfo): number {
    return getAbsoluteWindowPosition(win).y;
}

function normalizeSystemControlClass(controlClass: string | undefined): string {
    return (controlClass ?? '').trim().toLowerCase();
}

function isAnimateControlClass(controlClass: string): boolean {
    return controlClass === 'sysanimate32' || controlClass === 'sysanimate32_class';
}

function isCheckableButtonType(buttonType: number): boolean {
    return buttonType === BS_CHECKBOX
        || buttonType === BS_AUTOCHECKBOX
        || buttonType === BS_3STATE
        || buttonType === BS_AUTO3STATE
        || buttonType === BS_RADIOBUTTON
        || buttonType === BS_AUTORADIOBUTTON;
}

function isControlDisabled(child: WindowInfo): boolean {
    return (child.style & WS_DISABLED) !== 0;
}

function drawRaisedEdge(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    // Outer highlight
    ctx.fillStyle = COLOR_BTNHILIGHT;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y, 1, h);
    // Inner highlight
    ctx.fillStyle = COLOR_BTNINNERHI;
    ctx.fillRect(x + 1, y + 1, Math.max(1, w - 2), 1);
    ctx.fillRect(x + 1, y + 1, 1, Math.max(1, h - 2));
    // Inner shadow
    ctx.fillStyle = COLOR_BTNSHADOW;
    ctx.fillRect(x + 1, y + h - 2, Math.max(1, w - 2), 1);
    ctx.fillRect(x + w - 2, y + 1, 1, Math.max(1, h - 2));
    // Outer dark shadow
    ctx.fillStyle = COLOR_BTNDKSHADOW;
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x + w - 1, y, 1, h);
}

function drawSunkenEdge(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    // Outer shadow
    ctx.fillStyle = COLOR_BTNSHADOW;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y, 1, h);
    // Inner dark shadow
    ctx.fillStyle = COLOR_BTNDKSHADOW;
    ctx.fillRect(x + 1, y + 1, Math.max(1, w - 2), 1);
    ctx.fillRect(x + 1, y + 1, 1, Math.max(1, h - 2));
    // Outer highlight
    ctx.fillStyle = COLOR_BTNHILIGHT;
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x + w - 1, y, 1, h);
}

function paintPushButton(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
    isDefault: boolean,
    pushed: boolean,
): void {
    if (isDefault && w > 4 && h > 4) {
        ctx.fillStyle = COLOR_WINDOWTEXT;
        ctx.fillRect(x, y, w, h);
        x += 1;
        y += 1;
        w -= 2;
        h -= 2;
    }

    ctx.fillStyle = COLOR_BTNFACE;
    ctx.fillRect(x, y, w, h);
    if (pushed) {
        drawSunkenEdge(ctx, x, y, w, h);
    } else {
        drawRaisedEdge(ctx, x, y, w, h);
    }

    const label = child.title || '';
    if (!label) return;

    const disabled = isControlDisabled(child);
    const tx = pushed ? 1 : 0;
    const ty = pushed ? 1 : 0;
    ctx.font = getWindowFont(child);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (disabled) {
        ctx.fillStyle = COLOR_BTNHILIGHT;
        fillTextWithMnemonic(ctx, label, x + w / 2 + tx + 1, y + h / 2 + ty + 1);
        ctx.fillStyle = COLOR_GRAYTEXT;
        fillTextWithMnemonic(ctx, label, x + w / 2 + tx, y + h / 2 + ty);
    } else {
        ctx.fillStyle = COLOR_BTNTEXT;
        fillTextWithMnemonic(ctx, label, x + w / 2 + tx, y + h / 2 + ty);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
}

function paintGroupBox(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const label = child.title || '';

    ctx.font = getWindowFont(child);
    ctx.textBaseline = 'top';
    const textWidth = label ? Math.ceil(measureMnemonicText(ctx, label)) : 0;
    const textInset = 8;
    const textPad = label ? 6 : 0;
    const lineY = y + 7;
    const textStart = x + textInset;
    const textEnd = textStart + textWidth + textPad;

    ctx.fillStyle = COLOR_BTNSHADOW;
    if (label) {
        ctx.fillRect(x, lineY, Math.max(0, textStart - x - 2), 1);
        ctx.fillRect(textEnd, lineY, Math.max(0, x + w - textEnd), 1);
    } else {
        ctx.fillRect(x, lineY, w, 1);
    }
    ctx.fillRect(x, lineY, 1, Math.max(1, h - 7));
    ctx.fillRect(x + w - 1, lineY, 1, Math.max(1, h - 7));
    ctx.fillRect(x, y + h - 1, w, 1);

    if (label) {
        ctx.fillStyle = COLOR_BTNFACE;
        ctx.fillRect(textStart - 2, y, textWidth + textPad, 12);
        ctx.fillStyle = isControlDisabled(child) ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT;
        ctx.textAlign = 'left';
        fillTextWithMnemonic(ctx, label, textStart, y);
    }
}

function drawCheckMark(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
): void {
    ctx.strokeStyle = COLOR_WINDOWTEXT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + Math.max(2, Math.floor(size * 0.2)), y + Math.floor(size * 0.55));
    ctx.lineTo(x + Math.floor(size * 0.45), y + size - 3);
    ctx.lineTo(x + size - 2, y + 2);
    ctx.stroke();
    ctx.lineWidth = 1;
}

function paintCheckableButton(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
    buttonType: number,
): void {
    const state = buttonCheckStates.get(child.handle) ?? BST_UNCHECKED;
    const pushed = (state & BST_PUSHED) !== 0;
    const logicalState = state & ~BST_PUSHED;
    const checked = logicalState === BST_CHECKED || logicalState === BST_INDETERMINATE;
    const indeterminate = logicalState === BST_INDETERMINATE;
    const radio = buttonType === BS_RADIOBUTTON || buttonType === BS_AUTORADIOBUTTON;
    const disabled = isControlDisabled(child);

    const indicatorSize = Math.max(9, Math.min(13, h - 4));
    const indicatorX = x + 2;
    const indicatorY = y + Math.max(1, Math.floor((h - indicatorSize) / 2));

    if (radio) {
        ctx.fillStyle = COLOR_WINDOW;
        ctx.beginPath();
        ctx.arc(
            indicatorX + indicatorSize / 2,
            indicatorY + indicatorSize / 2,
            indicatorSize / 2,
            0,
            Math.PI * 2,
        );
        ctx.fill();
        ctx.strokeStyle = COLOR_BTNSHADOW;
        ctx.lineWidth = 1;
        ctx.stroke();

        if (checked) {
            ctx.fillStyle = disabled ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT;
            ctx.beginPath();
            ctx.arc(
                indicatorX + indicatorSize / 2,
                indicatorY + indicatorSize / 2,
                Math.max(2, indicatorSize / 4),
                0,
                Math.PI * 2,
            );
            ctx.fill();
        }
    } else {
        ctx.fillStyle = COLOR_WINDOW;
        ctx.fillRect(indicatorX, indicatorY, indicatorSize, indicatorSize);
        if (pushed) {
            drawSunkenEdge(ctx, indicatorX, indicatorY, indicatorSize, indicatorSize);
        } else {
            drawRaisedEdge(ctx, indicatorX, indicatorY, indicatorSize, indicatorSize);
        }

        if (indeterminate) {
            ctx.fillStyle = disabled ? COLOR_GRAYTEXT : COLOR_BTNSHADOW;
            ctx.fillRect(indicatorX + 3, indicatorY + 3, Math.max(2, indicatorSize - 6), Math.max(2, indicatorSize - 6));
        } else if (checked) {
            drawCheckMark(ctx, indicatorX, indicatorY, indicatorSize);
        }
    }

    const label = child.title || '';
    if (!label) return;

    // Overwrite the label area with an opaque background before drawing text. The
    // overlay is a persistent canvas repainted many times over a control's life
    // (WM_INITDIALOG, every content/click repaint); fillText's anti-aliased edge
    // pixels are only partially opaque, so redrawing the same text on top of itself
    // without first clearing compounds those edges darker each pass — a checkbox
    // repainted a dozen times ends up looking artificially bold / faintly
    // double-struck. Static/group-box text has the same exposure; fixing the
    // control most visibly affected (checkboxes repaint far more often, on every
    // click/content-change) first.
    const colors = getControlColorOverride(child.handle);
    const labelX = indicatorX + indicatorSize + 6;
    const labelFill = colors ? colors.fill : COLOR_BTNFACE;
    if (labelFill) {
        ctx.fillStyle = labelFill;
        ctx.fillRect(labelX - 1, y, Math.max(1, x + w - labelX + 1), h);
    }

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = disabled ? COLOR_GRAYTEXT : (colors?.text ?? COLOR_WINDOWTEXT);
    fillTextWithMnemonic(ctx, label, labelX, y + h / 2);
    ctx.textBaseline = 'top';
}

function paintButton(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const buttonType = child.style & BS_TYPEMASK;
    const state = buttonCheckStates.get(child.handle) ?? BST_UNCHECKED;
    const pushed = (state & BST_PUSHED) !== 0;

    if ((child.style & BS_BITMAP) !== 0) {
        paintStaticBitmap(ctx, child, x, y, w, h);
        const disabled = isControlDisabled(child);
        const pushed = (buttonCheckStates.get(child.handle) ?? 0) & BST_PUSHED;
        if (disabled || pushed) {
            ctx.fillStyle = disabled ? 'rgba(128,128,128,0.45)' : 'rgba(0,0,0,0.15)';
            ctx.fillRect(x, y, w, h);
        }
        return;
    }

    // Owner-draw button: the guest draws the button face via WM_DRAWITEM. If the
    // parent has not painted a custom client yet, draw a default pushbutton fallback
    // so a standard dialog remains usable before/without the guest draw.
    if (buttonType === BS_OWNERDRAW) {
        const parent = child.parent !== undefined ? windows.get(child.parent) : undefined;
        const guestPaintsButton = !!parent?.guestCustomPaint;
        if (!guestPaintsButton && (child.title || '').length > 0) {
            paintPushButton(ctx, child, x, y, w, h, false, pushed);
        }
        return;
    }

    if (buttonType === BS_GROUPBOX) {
        paintGroupBox(ctx, child, x, y, w, h);
        return;
    }

    if (isCheckableButtonType(buttonType)) {
        paintCheckableButton(ctx, child, x, y, w, h, buttonType);
        return;
    }

    const isDefault = buttonType === BS_DEFPUSHBUTTON;
    paintPushButton(ctx, child, x, y, w, h, isDefault, pushed);
}

function drawStaticShape(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    styleType: number,
): void {
    switch (styleType) {
        case SS_BLACKRECT:
            ctx.fillStyle = '#000000';
            ctx.fillRect(x, y, w, h);
            return;
        case SS_GRAYRECT:
            ctx.fillStyle = COLOR_BTNSHADOW;
            ctx.fillRect(x, y, w, h);
            return;
        case SS_WHITERECT:
            ctx.fillStyle = COLOR_BTNHILIGHT;
            ctx.fillRect(x, y, w, h);
            return;
        case SS_BLACKFRAME:
            ctx.strokeStyle = '#000000';
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            return;
        case SS_GRAYFRAME:
            ctx.strokeStyle = COLOR_BTNSHADOW;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            return;
        case SS_WHITEFRAME:
            ctx.strokeStyle = COLOR_BTNHILIGHT;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            return;
        case SS_ETCHEDHORZ: {
            const lineY = y + Math.floor(h / 2);
            ctx.fillStyle = COLOR_BTNSHADOW;
            ctx.fillRect(x, lineY, w, 1);
            ctx.fillStyle = COLOR_BTNHILIGHT;
            ctx.fillRect(x, lineY + 1, w, 1);
            return;
        }
        case SS_ETCHEDVERT: {
            const lineX = x + Math.floor(w / 2);
            ctx.fillStyle = COLOR_BTNSHADOW;
            ctx.fillRect(lineX, y, 1, h);
            ctx.fillStyle = COLOR_BTNHILIGHT;
            ctx.fillRect(lineX + 1, y, 1, h);
            return;
        }
        case SS_ETCHEDFRAME:
            ctx.strokeStyle = COLOR_BTNSHADOW;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            ctx.strokeStyle = COLOR_BTNHILIGHT;
            ctx.strokeRect(x + 1.5, y + 1.5, Math.max(1, w - 3), Math.max(1, h - 3));
            return;
    }
}

/** Word-wrap one line to maxWidth px. Measures with the mnemonic '&' collapsed (so it
 *  isn't counted as a glyph), matching fillTextWithMnemonic's drawn width. */
function wrapStaticLine(
    ctx: OffscreenCanvasRenderingContext2D,
    line: string,
    maxWidth: number,
    processPrefix: boolean,
): string[] {
    const measure = (s: string): number =>
        ctx.measureText(processPrefix ? s.replace(/&(.?)/g, '$1') : s).width;
    if (line === '' || measure(line) <= maxWidth) return [line];
    const words = line.split(' ');
    const out: string[] = [];
    let cur = '';
    for (const word of words) {
        const test = cur ? `${cur} ${word}` : word;
        if (cur && measure(test) > maxWidth) {
            out.push(cur);
            cur = word;
        } else {
            cur = test;
        }
    }
    if (cur) out.push(cur);
    return out.length ? out : [line];
}

function paintStaticBitmap(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const hBitmap = controlImageHandles.get(child.handle);
    if (!hBitmap) return;

    const mem = System.getInstance().process?.v86?.mem8
        ?? System.getInstance().process?.v86?.v86?.cpu?.mem8;
    const resolved = resolveBitmapRgba(hBitmap, mem);
    if (!resolved) {
        Logger.verbose(LogCategory.USER32, `paintStaticBitmap: no bitmap data for hBitmap=0x${hBitmap.toString(16)}`);
        return;
    }

    const { data, width: bmpW, height: bmpH } = resolved;
    const layout = layoutStaticControlImage(x, y, w, h, bmpW, bmpH, child.style, SS_CENTERIMAGE);
    try {
        blitStaticControlImage(ctx, data, bmpW, bmpH, x, y, w, h, layout);
    } catch (e) {
        Logger.warn(LogCategory.USER32, `paintStaticBitmap: failed to draw bitmap: ${e}`);
    }
}

function paintStaticIcon(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const hIcon = controlImageHandles.get(child.handle);
    if (!hIcon) return;

    const resolved = resolveIconRgba(hIcon);
    if (!resolved) return;

    const { data, width: iconW, height: iconH } = resolved;
    const layout = layoutStaticControlImage(x, y, w, h, iconW, iconH, child.style, SS_CENTERIMAGE);
    try {
        blitStaticControlImage(ctx, data, iconW, iconH, x, y, w, h, layout);
    } catch (e) {
        Logger.warn(LogCategory.USER32, `paintStaticIcon: failed: ${e}`);
    }
}

function paintStatic(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const styleType = child.style & SS_TYPEMASK;
    const coveredByGuestChild = styleType >= SS_BLACKRECT && styleType <= SS_WHITEFRAME
        && isFullyCoveredByGuestChild(child.handle);

    // STM_SETIMAGE can supply bitmap content while the control retains a
    // non-image SS_TYPE. Render the supplied image instead of re-stamping the
    // declared class shape (for example an SS_WHITEFRAME) over it.
    if (controlImageHandles.has(child.handle)
        && styleType !== SS_ICON && styleType !== SS_BITMAP) {
        // Restore guest-owned bitmap content during parent/page recomposition.
        paintStaticBitmap(ctx, child, x, y, w, h);
        return;
    }

    // Preserve bitmap content behind a hosted page, but suppress placeholder
    // RECT/FRAME chrome when the child completely covers the STATIC.
    if (coveredByGuestChild) return;

    if (styleType === SS_ICON) {
        paintStaticIcon(ctx, child, x, y, w, h);
        return;
    }

    if (styleType === SS_BITMAP) {
        paintStaticBitmap(ctx, child, x, y, w, h);
        return;
    }

    drawStaticShape(ctx, x, y, w, h, styleType);

    const isTextType = styleType === SS_LEFT || styleType === SS_CENTER || styleType === SS_RIGHT
        || styleType === SS_SIMPLE || styleType === SS_LEFTNOWORDWRAP;
    const colors = getControlColorOverride(child.handle);
    if (isTextType && colors?.fill) {
        // WM_CTLCOLORSTATIC returned a background brush — the static is opaque.
        ctx.fillStyle = colors.fill;
        ctx.fillRect(x, y, w, h);
    }

    const text = child.title || '';
    if (!text) return;

    const processPrefix = (child.style & SS_NOPREFIX) === 0;
    const lineHeight = 14;
    const disabled = isControlDisabled(child);

    ctx.font = getWindowFont(child);
    ctx.fillStyle = disabled ? COLOR_GRAYTEXT : (colors?.text ?? COLOR_WINDOWTEXT);
    ctx.textBaseline = 'top';

    // SS_LEFT/SS_CENTER/SS_RIGHT word-wrap to the control width (real Win32); only
    // SS_LEFTNOWORDWRAP and SS_SIMPLE render single-line. Without wrapping, a long
    // label (Airfix launcher's "Press Advanced to see advanced settings…") overflows
    // its box and stamps over the neighbouring Advanced button.
    const wordWraps = styleType === SS_LEFT || styleType === SS_CENTER || styleType === SS_RIGHT;
    let lines = text.split(/\r\n|\n|\r/g);
    if (wordWraps) {
        const maxW = Math.max(1, w - 4);
        lines = lines.flatMap((l) => wrapStaticLine(ctx, l, maxW, processPrefix));
    }

    let textY = y + 2;
    if ((child.style & SS_CENTERIMAGE) !== 0) {
        const contentHeight = lines.length * lineHeight;
        textY = y + Math.max(0, Math.floor((h - contentHeight) / 2));
    }

    for (let i = 0; i < lines.length; i++) {
        const lineY = textY + i * lineHeight;
        // Only reject SUBSEQUENT lines that overflow — a single-line static must
        // always draw its text. DLU→px conversion routinely yields a control height
        // (e.g. 15px) a couple pixels short of lineHeight+padding (16px); rejecting
        // the first line entirely for that made every such static (any single-line
        // label whose template height came out tight) render as fully blank chrome
        // with visible+correct state and no drawing error — a "control is missing"
        // symptom, not a clipping one. Real Windows just draws the line.
        if (i > 0 && lineY + lineHeight > y + h) break;

        if (styleType === SS_CENTER) {
            ctx.textAlign = 'center';
            fillTextWithMnemonic(ctx, lines[i], x + w / 2, lineY, processPrefix);
        } else if (styleType === SS_RIGHT) {
            ctx.textAlign = 'right';
            fillTextWithMnemonic(ctx, lines[i], x + w - 2, lineY, processPrefix);
        } else if (styleType === SS_LEFT || styleType === SS_LEFTNOWORDWRAP || styleType === SS_SIMPLE) {
            ctx.textAlign = 'left';
            fillTextWithMnemonic(ctx, lines[i], x + 2, lineY, processPrefix);
        } else {
            ctx.textAlign = 'left';
            fillTextWithMnemonic(ctx, lines[i], x + 2, lineY, processPrefix);
        }
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
}

function paintEdit(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const disabled = isControlDisabled(child);
    const colors = getControlColorOverride(child.handle);

    // A guest that answered WM_CTLCOLOR* decides the fill outright, including "none"
    // (hollow brush); only an unanswered query falls back to the class default.
    const fill = disabled ? COLOR_BTNFACE : (colors ? colors.fill : COLOR_WINDOW);
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
    }
    drawSunkenEdge(ctx, x, y, w, h);

    const visual = getEditVisualState(child);
    const textColor = disabled ? COLOR_GRAYTEXT : (colors?.text ?? COLOR_WINDOWTEXT);
    const text = visual.passwordChar
        ? String.fromCharCode(visual.passwordChar).repeat(child.title.length)
        : (child.title || '');

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, Math.max(1, w - 4), Math.max(1, h - 4));
    ctx.clip();
    const ES_MULTILINE = 0x0004;
    if ((child.style & ES_MULTILINE) !== 0) {
        ctx.textBaseline = 'top';
        const lineHeight = 14;
        const lines = text.split(/\r\n|\n|\r/g);
        let ty = y + 4;
        for (const line of lines) {
            if (ty + lineHeight > y + h - 2) break;
            ctx.fillText(line, x + EDIT_TEXT_INSET, ty);
            ty += lineHeight;
        }
    } else {
        // Text origin walks left by the control's horizontal scroll (EM_SCROLLCARET), so
        // a single-line edit longer than its box keeps the caret inside the clip rect.
        const tx = x + EDIT_TEXT_INSET - visual.scrollX;
        const ty = y + h / 2;
        const selLo = Math.min(visual.selStart, visual.selEnd);
        const selHi = Math.max(visual.selStart, visual.selEnd);

        if (visual.focused && selLo !== selHi) {
            const x0 = tx + ctx.measureText(text.slice(0, selLo)).width;
            const x1 = tx + ctx.measureText(text.slice(0, selHi)).width;
            ctx.fillStyle = COLOR_HIGHLIGHT;
            ctx.fillRect(x0, y + 3, Math.max(1, x1 - x0), h - 6);
            ctx.fillStyle = textColor;
            if (text) ctx.fillText(text.slice(0, selLo), tx, ty);
            ctx.fillStyle = COLOR_HIGHLIGHTTEXT;
            ctx.fillText(text.slice(selLo, selHi), x0, ty);
            ctx.fillStyle = textColor;
            ctx.fillText(text.slice(selHi), x1, ty);
        } else {
            if (text) {
                ctx.fillStyle = textColor;
                ctx.fillText(text, tx, ty);
            }
            if (visual.focused && !disabled) {
                const caretX = tx + ctx.measureText(text.slice(0, visual.selEnd)).width;
                ctx.fillStyle = COLOR_WINDOWTEXT;
                ctx.fillRect(Math.round(caretX), y + 3, 1, h - 6);
            }
        }
    }
    ctx.restore();
    ctx.textBaseline = 'top';
}

// Dropdown arrow button width (Windows classic = 16px)
const COMBO_ARROW_W = 16;
/** Listbox / dropdown item height (matches CONTROL_FONT metrics). */
export const LIST_ITEM_H = 14;
/** Listbox border inset before the first item. */
export const LIST_INSET = 2;
/** Vertical scrollbar width inside an overflowing listbox / dropdown. */
export const LIST_SCROLLBAR_W = 14;
/** Max items shown in an open combobox dropdown. */
export const COMBO_DROP_MAX_VISIBLE = 8;

/** Number of fully visible items in a listbox of height h. */
export function listVisibleCount(h: number): number {
    return Math.max(1, Math.floor((h - LIST_INSET * 2) / LIST_ITEM_H));
}

/** Listbox needs a scrollbar when items overflow the client height. */
export function listNeedsScrollbar(child: WindowInfo): boolean {
    const state = listControlStates.get(child.handle);
    return !!state && state.items.length > listVisibleCount(child.height);
}

/** Clamp topIndex so the visible window stays within the item list. */
export function clampListTopIndex(state: { items: unknown[]; topIndex: number }, h: number): void {
    const maxTop = Math.max(0, state.items.length - listVisibleCount(h));
    state.topIndex = Math.max(0, Math.min(state.topIndex | 0, maxTop));
}

/** Screen-space rect of an open combobox dropdown list (below the closed box). */
export function getComboDropdownRect(child: WindowInfo): { x: number; y: number; w: number; h: number } {
    const { x, y } = getChainAbs(child);
    const state = listControlStates.get(child.handle);
    const count = Math.max(1, Math.min(state?.items.length ?? 0, COMBO_DROP_MAX_VISIBLE));
    return { x, y: y + child.height, w: child.width, h: count * LIST_ITEM_H + 2 };
}

function paintComboBox(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const textW = Math.max(1, w - COMBO_ARROW_W);
    const disabled = isControlDisabled(child);

    // Backgrounds first (white text field, gray button field), THEN one continuous
    // sunken frame around the whole control — classic Win32 combobox chrome is a
    // single recessed field with the arrow button inset near its right edge, not two
    // separately-bordered boxes side by side.
    ctx.fillStyle = disabled ? COLOR_BTNFACE : COLOR_WINDOW;
    ctx.fillRect(x, y, textW, h);
    ctx.fillStyle = COLOR_BTNFACE;
    ctx.fillRect(x + textW, y, COMBO_ARROW_W, h);
    drawSunkenEdge(ctx, x, y, w, h);

    const state = listControlStates.get(child.handle);
    if (state && state.selectedIndex >= 0 && state.selectedIndex < state.items.length) {
        const text = state.items[state.selectedIndex].text;
        ctx.fillStyle = disabled ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT;
        ctx.font = getWindowFont(child);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 3, y + 2, Math.max(1, textW - 5), Math.max(1, h - 4));
        ctx.clip();
        ctx.fillText(text, x + 4, y + h / 2);
        ctx.restore();
        ctx.textBaseline = 'top';
    }

    // Arrow button: a small raised (sunken while the dropdown is open) bevel filling
    // the button area, clearing only the outer sunken frame's own border pixels (2px
    // shadow on top/left, 1px highlight on bottom/right) — no left-side inset, or a
    // flat unstyled gray gap is left between the text field and the button's bevel.
    const ax = x + textW;
    const bx = ax, by = y + 2, bw = Math.max(1, COMBO_ARROW_W - 1), bh = Math.max(1, h - 3);
    if (state?.dropdownOpen) {
        drawSunkenEdge(ctx, bx, by, bw, bh);
    } else {
        drawRaisedEdge(ctx, bx, by, bw, bh);
    }

    const arrowCx = bx + bw / 2;
    const arrowCy = by + bh / 2;
    ctx.fillStyle = disabled ? COLOR_GRAYTEXT : COLOR_BTNTEXT;
    ctx.beginPath();
    ctx.moveTo(arrowCx - 3, arrowCy - 1);
    ctx.lineTo(arrowCx + 3, arrowCy - 1);
    ctx.lineTo(arrowCx, arrowCy + 2);
    ctx.closePath();
    ctx.fill();
}

/** Painted after all siblings so the open list overlaps controls below the combo. */
function paintComboDropdown(ctx: OffscreenCanvasRenderingContext2D, child: WindowInfo): void {
    const state = listControlStates.get(child.handle);
    if (!state) return;
    const rect = getComboDropdownRect(child);

    ctx.fillStyle = COLOR_WINDOW;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = COLOR_WINDOWTEXT;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    clampListTopIndex(state, rect.h);
    const visible = Math.min(state.items.length - state.topIndex, COMBO_DROP_MAX_VISIBLE);
    for (let i = 0; i < visible; i++) {
        const idx = state.topIndex + i;
        const iy = rect.y + 1 + i * LIST_ITEM_H;
        if (idx === state.selectedIndex) {
            ctx.fillStyle = '#000080';
            ctx.fillRect(rect.x + 1, iy, rect.w - 2, LIST_ITEM_H);
            ctx.fillStyle = COLOR_BTNHILIGHT;
        } else {
            ctx.fillStyle = COLOR_WINDOWTEXT;
        }
        ctx.fillText(state.items[idx].text, rect.x + 3, iy + 1);
    }
}

function paintListBox(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const disabled = isControlDisabled(child);
    const colors = getControlColorOverride(child.handle);

    // A guest that answered WM_CTLCOLOR* decides the fill outright, including "none"
    // (hollow brush); only an unanswered query falls back to the class default.
    const fill = disabled ? COLOR_BTNFACE : (colors ? colors.fill : COLOR_WINDOW);
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
    }
    drawSunkenEdge(ctx, x, y, w, h);

    const state = listControlStates.get(child.handle);
    if (!state) return;

    clampListTopIndex(state, h);
    const maxVisible = listVisibleCount(h);
    const hasScrollbar = state.items.length > maxVisible;
    const itemW = w - LIST_INSET * 2 - (hasScrollbar ? LIST_SCROLLBAR_W : 0);

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    ctx.save();
    ctx.beginPath();
    ctx.rect(x + LIST_INSET, y + LIST_INSET, Math.max(1, itemW), Math.max(1, h - LIST_INSET * 2));
    ctx.clip();

    const visible = Math.min(state.items.length - state.topIndex, maxVisible);
    for (let i = 0; i < visible; i++) {
        const idx = state.topIndex + i;
        const iy = y + LIST_INSET + i * LIST_ITEM_H;
        if (!disabled && idx === state.selectedIndex) {
            ctx.fillStyle = '#000080';
            ctx.fillRect(x + LIST_INSET, iy, Math.max(1, itemW), LIST_ITEM_H);
            ctx.fillStyle = COLOR_BTNHILIGHT;
        } else {
            ctx.fillStyle = disabled ? COLOR_GRAYTEXT : (colors?.text ?? COLOR_WINDOWTEXT);
        }
        ctx.fillText(state.items[idx].text, x + 4, iy + 1);
    }

    ctx.restore();

    if (hasScrollbar) {
        paintListScrollbar(ctx, x, y, w, h, state.topIndex, maxVisible, state.items.length);
    }
}

function colorRefToCss(color: number, fallback: string): string {
    if (color === 0xFFFFFFFF || color === 0xFF000000) return fallback; // CLR_NONE / CLR_DEFAULT
    const r = color & 0xFF;
    const g = (color >> 8) & 0xFF;
    const b = (color >> 16) & 0xFF;
    return `rgb(${r},${g},${b})`;
}

function paintListView(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const disabled = isControlDisabled(child);
    const state = getListViewState(child.handle);
    const bk = colorRefToCss(state?.bkColor ?? 0xFF000000, COLOR_WINDOW);
    const textColor = colorRefToCss(state?.textColor ?? 0xFF000000, COLOR_WINDOWTEXT);
    const textBk = colorRefToCss(state?.textBkColor ?? 0xFF000000, bk);

    ctx.fillStyle = disabled ? COLOR_BTNFACE : bk;
    ctx.fillRect(x, y, w, h);
    drawSunkenEdge(ctx, x, y, w, h);
    if (!state) return;

    clampListViewTopIndex(child, state);
    const view = listViewViewStyle(child.style);
    const headerH = listViewHasHeader(child) ? LV_HEADER_H : 0;
    const rowH = listViewRowHeight(child);
    const inset = 2;
    const focused = System.getInstance().windowManager.getFocusHwnd() === child.handle;
    const showSel = focused || (child.style & LVS_SHOWSELALWAYS) !== 0;
    const maxVisible = listViewVisibleCount(child);
    const hasScrollbar = state.items.length > maxVisible;
    const bodyW = w - inset * 2 - (hasScrollbar ? LV_SCROLLBAR_W : 0);

    if (headerH > 0) {
        ctx.fillStyle = COLOR_BTNFACE;
        ctx.fillRect(x + inset, y + inset, Math.max(1, bodyW), headerH);
        ctx.font = getWindowFont(child);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let colX = x + inset - state.scrollX;
        for (const col of state.columns) {
            const cx = Math.max(0, col.cx);
            drawRaisedEdge(ctx, colX, y + inset, Math.max(1, cx), headerH);
            ctx.save();
            ctx.beginPath();
            ctx.rect(colX + 2, y + inset, Math.max(1, cx - 4), headerH);
            ctx.clip();
            ctx.fillStyle = COLOR_BTNTEXT;
            ctx.fillText(col.text, colX + 4, y + inset + headerH / 2);
            ctx.restore();
            colX += cx;
        }
    }

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const bodyTop = y + inset + headerH;
    const bodyH = Math.max(1, h - inset * 2 - headerH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + inset, bodyTop, Math.max(1, bodyW), bodyH);
    ctx.clip();

    if (view === LVS_ICON) {
        const cellW = LV_ICON_SIZE + 40;
        const cellH = rowH;
        const cols = Math.max(1, Math.floor(bodyW / cellW));
        let drawn = 0;
        for (let i = state.topIndex; i < state.items.length && drawn < maxVisible * cols; i++) {
            const local = i - state.topIndex;
            const col = local % cols;
            const row = Math.floor(local / cols);
            const ix = x + inset + col * cellW;
            const iy = bodyTop + row * cellH;
            paintListViewItemChrome(ctx, state.items[i], ix, iy, cellW, cellH, showSel, disabled, textColor, textBk, true);
            drawn++;
        }
    } else {
        const iconSize = (view === LVS_SMALLICON || view === LVS_LIST || view === LVS_REPORT)
            ? LV_SMALL_ICON_SIZE : 0;
        const visible = Math.min(state.items.length - state.topIndex, maxVisible);
        for (let i = 0; i < visible; i++) {
            const idx = state.topIndex + i;
            const item = state.items[idx];
            const iy = bodyTop + i * rowH;
            const selected = showSel && (item.state & LVIS_SELECTED) !== 0;
            const rowW = view === LVS_REPORT && state.columns.length > 0
                ? state.columns.reduce((s, c) => s + Math.max(0, c.cx), 0)
                : bodyW;

            if (selected) {
                ctx.fillStyle = COLOR_HIGHLIGHT;
                ctx.fillRect(x + inset - (view === LVS_REPORT ? state.scrollX : 0), iy, Math.max(1, rowW), rowH);
            } else if (state.textBkColor !== 0xFFFFFFFF) {
                ctx.fillStyle = textBk;
                ctx.fillRect(x + inset, iy, Math.max(1, bodyW), rowH);
            }

            let textX = x + inset + LV_TEXT_INSET - (view === LVS_REPORT ? state.scrollX : 0);
            if (iconSize > 0 && (state.himlSmall || state.himlNormal || item.iImage >= 0)) {
                const iconY = iy + Math.max(0, (rowH - iconSize) / 2);
                ctx.fillStyle = selected ? COLOR_HIGHLIGHTTEXT : '#808080';
                ctx.fillRect(textX, iconY, iconSize, iconSize);
                ctx.strokeStyle = selected ? COLOR_HIGHLIGHTTEXT : '#404040';
                ctx.strokeRect(textX + 0.5, iconY + 0.5, iconSize - 1, iconSize - 1);
                textX += iconSize + 4;
            }

            ctx.fillStyle = disabled ? COLOR_GRAYTEXT : (selected ? COLOR_HIGHLIGHTTEXT : textColor);
            if (view === LVS_REPORT && state.columns.length > 0) {
                let colX = x + inset - state.scrollX;
                for (let c = 0; c < state.columns.length; c++) {
                    const cx = Math.max(0, state.columns[c].cx);
                    const label = c === 0 ? item.text : (item.subItems[c - 1]?.text ?? '');
                    const tx = c === 0 ? textX : colX + LV_TEXT_INSET;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(colX + 1, iy, Math.max(1, cx - 2), rowH);
                    ctx.clip();
                    ctx.fillText(label, tx, iy + rowH / 2);
                    ctx.restore();
                    colX += cx;
                }
            } else {
                ctx.fillText(item.text, textX, iy + rowH / 2);
            }

            if ((item.state & LVIS_FOCUSED) && focused) {
                ctx.save();
                ctx.strokeStyle = selected ? COLOR_HIGHLIGHTTEXT : COLOR_WINDOWTEXT;
                ctx.setLineDash([1, 1]);
                ctx.strokeRect(x + inset + 1, iy + 1, Math.max(1, bodyW - 2), rowH - 2);
                ctx.restore();
            }
        }
    }

    ctx.restore();

    if (hasScrollbar) {
        paintListScrollbar(
            ctx, x, y + headerH, w, h - headerH,
            state.topIndex, maxVisible, state.items.length,
        );
    }
}

function paintListViewItemChrome(
    ctx: OffscreenCanvasRenderingContext2D,
    item: { text: string; state: number; iImage: number },
    x: number, y: number, w: number, h: number,
    showSel: boolean, disabled: boolean, textColor: string, _textBk: string,
    largeIcon: boolean,
): void {
    const selected = showSel && (item.state & LVIS_SELECTED) !== 0;
    const icon = largeIcon ? LV_ICON_SIZE : LV_SMALL_ICON_SIZE;
    const ix = x + (w - icon) / 2;
    const iy = y + LV_ICON_PAD;
    if (selected) {
        ctx.fillStyle = COLOR_HIGHLIGHT;
        ctx.fillRect(ix - 2, iy - 2, icon + 4, icon + 4);
    }
    ctx.fillStyle = selected ? COLOR_HIGHLIGHTTEXT : '#808080';
    ctx.fillRect(ix, iy, icon, icon);
    ctx.strokeStyle = '#404040';
    ctx.strokeRect(ix + 0.5, iy + 0.5, icon - 1, icon - 1);

    ctx.fillStyle = disabled ? COLOR_GRAYTEXT : (selected ? COLOR_HIGHLIGHTTEXT : textColor);
    ctx.textAlign = 'center';
    ctx.fillText(item.text, x + w / 2, iy + icon + 10);
    ctx.textAlign = 'left';
}

/** Classic vertical scrollbar (up/down arrows + proportional thumb) inside a listbox. */
function paintListScrollbar(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    topIndex: number, visibleCount: number, itemCount: number,
): void {
    const sbX = x + w - LIST_INSET - LIST_SCROLLBAR_W;
    const sbY = y + LIST_INSET;
    const sbH = h - LIST_INSET * 2;
    const arrow = Math.min(14, Math.floor(sbH / 2));

    ctx.fillStyle = '#E8E8E8';
    ctx.fillRect(sbX, sbY, LIST_SCROLLBAR_W, sbH);

    // Arrow buttons
    ctx.fillStyle = COLOR_BTNFACE;
    ctx.fillRect(sbX, sbY, LIST_SCROLLBAR_W, arrow);
    drawRaisedEdge(ctx, sbX, sbY, LIST_SCROLLBAR_W, arrow);
    ctx.fillRect(sbX, sbY + sbH - arrow, LIST_SCROLLBAR_W, arrow);
    drawRaisedEdge(ctx, sbX, sbY + sbH - arrow, LIST_SCROLLBAR_W, arrow);

    const cx = sbX + LIST_SCROLLBAR_W / 2;
    ctx.fillStyle = COLOR_BTNTEXT;
    ctx.beginPath();
    ctx.moveTo(cx, sbY + 4);
    ctx.lineTo(cx - 3, sbY + arrow - 5);
    ctx.lineTo(cx + 3, sbY + arrow - 5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, sbY + sbH - 4);
    ctx.lineTo(cx - 3, sbY + sbH - arrow + 5);
    ctx.lineTo(cx + 3, sbY + sbH - arrow + 5);
    ctx.closePath();
    ctx.fill();

    // Proportional thumb
    const trackTop = sbY + arrow;
    const trackH = Math.max(0, sbH - arrow * 2);
    if (trackH > 6 && itemCount > visibleCount) {
        const thumbH = Math.max(8, Math.floor(trackH * visibleCount / itemCount));
        const maxTop = itemCount - visibleCount;
        const thumbY = trackTop + Math.floor((trackH - thumbH) * Math.min(1, topIndex / maxTop));
        ctx.fillStyle = COLOR_BTNFACE;
        ctx.fillRect(sbX + 1, thumbY, LIST_SCROLLBAR_W - 2, thumbH);
        drawRaisedEdge(ctx, sbX + 1, thumbY, LIST_SCROLLBAR_W - 2, thumbH);
    }
}

/** Trackbar (msctls_trackbar32): channel + thumb + tick marks, horizontal or vertical. */
function paintTrackbar(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const state = getOrCreateTrackbarState(child.handle);
    const range = Math.max(1, state.max - state.min);
    const frac = Math.max(0, Math.min(1, (state.pos - state.min) / range));
    const TBS_VERT = 0x0002;
    const vertical = (child.style & TBS_VERT) !== 0 || h > w * 2;

    if (vertical) {
        const cx = x + Math.floor(w / 2);
        const margin = 8;
        const trackH = Math.max(1, h - margin * 2);
        ctx.fillStyle = COLOR_WINDOW;
        ctx.fillRect(cx - 2, y + margin, 4, trackH);
        drawSunkenEdge(ctx, cx - 2, y + margin, 4, trackH);

        const thumbH = 10;
        const thumbW = Math.max(8, Math.min(20, w - 4));
        const ty = y + margin + Math.floor((trackH - thumbH) * frac);
        ctx.fillStyle = COLOR_BTNFACE;
        ctx.fillRect(cx - thumbW / 2, ty, thumbW, thumbH);
        drawRaisedEdge(ctx, Math.floor(cx - thumbW / 2), ty, thumbW, thumbH);
    } else {
        const cy = y + Math.floor(h / 2);
        const margin = 8;
        const trackW = Math.max(1, w - margin * 2);
        ctx.fillStyle = COLOR_WINDOW;
        ctx.fillRect(x + margin, cy - 2, trackW, 4);
        drawSunkenEdge(ctx, x + margin, cy - 2, trackW, 4);

        // Tick marks below the channel
        if (state.ticFreq > 0 && range / state.ticFreq <= 50) {
            ctx.fillStyle = COLOR_BTNSHADOW;
            for (let v = state.min; v <= state.max; v += state.ticFreq) {
                const tx = x + margin + Math.floor(trackW * (v - state.min) / range);
                ctx.fillRect(tx, cy + 6, 1, 3);
            }
        }

        const thumbW = 10;
        const thumbH = Math.max(12, Math.min(20, h - 4));
        const tx = x + margin + Math.floor((trackW - thumbW) * frac);
        ctx.fillStyle = COLOR_BTNFACE;
        ctx.fillRect(tx, cy - Math.floor(thumbH / 2), thumbW, thumbH);
        drawRaisedEdge(ctx, tx, cy - Math.floor(thumbH / 2), thumbW, thumbH);
    }
}

/** Progress bar (msctls_progress32): sunken channel + filled fraction. */
function paintProgressBar(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const state = getOrCreateTrackbarState(child.handle);
    const range = Math.max(1, state.max - state.min);
    const frac = Math.max(0, Math.min(1, (state.pos - state.min) / range));

    ctx.fillStyle = COLOR_BTNFACE;
    ctx.fillRect(x, y, w, h);
    drawSunkenEdge(ctx, x, y, w, h);

    const fillW = Math.floor((w - 4) * frac);
    if (fillW > 0) {
        ctx.fillStyle = '#000080';
        ctx.fillRect(x + 2, y + 2, fillW, Math.max(1, h - 4));
    }
}

function paintScrollBar(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const vertical = ((child.style & SBS_VERT) !== 0) || h > w;
    const arrow = Math.max(12, Math.min(16, vertical ? w : h));

    ctx.fillStyle = COLOR_BTNFACE;
    ctx.fillRect(x, y, w, h);
    drawSunkenEdge(ctx, x, y, w, h);

    if (vertical) {
        const trackTop = y + arrow;
        const trackBottom = y + h - arrow;
        const thumbH = Math.max(10, Math.floor((trackBottom - trackTop) * 0.35));
        const thumbY = trackTop + Math.max(0, Math.floor((trackBottom - trackTop - thumbH) / 2));

        drawRaisedEdge(ctx, x + 1, y + 1, w - 2, arrow - 1);
        drawRaisedEdge(ctx, x + 1, y + h - arrow, w - 2, arrow - 1);
        drawRaisedEdge(ctx, x + 2, thumbY, Math.max(4, w - 4), thumbH);

        const cx = x + w / 2;
        ctx.fillStyle = COLOR_BTNTEXT;
        ctx.beginPath();
        ctx.moveTo(cx, y + 4);
        ctx.lineTo(cx - 4, y + arrow - 4);
        ctx.lineTo(cx + 4, y + arrow - 4);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(cx, y + h - 4);
        ctx.lineTo(cx - 4, y + h - arrow + 4);
        ctx.lineTo(cx + 4, y + h - arrow + 4);
        ctx.closePath();
        ctx.fill();
    } else {
        const trackLeft = x + arrow;
        const trackRight = x + w - arrow;
        const thumbW = Math.max(10, Math.floor((trackRight - trackLeft) * 0.35));
        const thumbX = trackLeft + Math.max(0, Math.floor((trackRight - trackLeft - thumbW) / 2));

        drawRaisedEdge(ctx, x + 1, y + 1, arrow - 1, h - 2);
        drawRaisedEdge(ctx, x + w - arrow, y + 1, arrow - 1, h - 2);
        drawRaisedEdge(ctx, thumbX, y + 2, thumbW, Math.max(4, h - 4));

        const cy = y + h / 2;
        ctx.fillStyle = COLOR_BTNTEXT;
        ctx.beginPath();
        ctx.moveTo(x + 4, cy);
        ctx.lineTo(x + arrow - 4, cy - 4);
        ctx.lineTo(x + arrow - 4, cy + 4);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(x + w - 4, cy);
        ctx.lineTo(x + w - arrow + 4, cy - 4);
        ctx.lineTo(x + w - arrow + 4, cy + 4);
        ctx.closePath();
        ctx.fill();
    }
}

function paintGenericControl(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    if (isAnimateControlClass(normalizeSystemControlClass(child.systemControlClass))) return;

    ctx.fillStyle = COLOR_BTNFACE;
    ctx.fillRect(x, y, w, h);
    drawRaisedEdge(ctx, x, y, w, h);

    const text = child.title || '';
    if (!text) return;

    ctx.fillStyle = isControlDisabled(child) ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT;
    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, Math.max(1, w - 4), Math.max(1, h - 4));
    ctx.clip();
    fillTextWithMnemonic(ctx, text, x + 4, y + h / 2);
    ctx.restore();
    ctx.textBaseline = 'top';
}

// Owned-popup restamp hook — dialog-paint.ts registers the Z-order restore that
// re-stamps modal popups floating above this window (cross-module hook avoids a
// controls.ts <-> dialog-paint.ts import cycle).
let ownedPopupRestamper: ((hwnd: number) => void) | null = null;
export function registerOwnedPopupRestamper(fn: (hwnd: number) => void): void {
    ownedPopupRestamper = fn;
}

export function repaintChildControls(parentHwnd: number): void {
    const gdi = System.getInstance().gdiContext;
    const hdc = gdi.createOverlayDC();
    if (!hdc) return;

    paintChildControls(parentHwnd, hdc, gdi);
    gdi.releaseDC(hdc);
    // A controls-only repaint of a lower window would overpaint a modal it owns;
    // the flat overlay has no Z-clip, so re-stamp any owned popup back on top.
    ownedPopupRestamper?.(parentHwnd);
}

/** Hit-test system controls under a parent using parent-client coordinates. */
export function hitTestSystemControlAtClient(
    parentHwnd: number,
    clientX: number,
    clientY: number,
): WindowInfo | undefined {
    const parent = windows.get(parentHwnd);
    if (!parent) return undefined;

    const { x: parentAbsX, y: parentAbsY } = getChainAbs(parent);
    const screenX = parentAbsX + clientX;
    const screenY = parentAbsY + clientY;
    return hitTestSystemControlAtScreen(parentHwnd, screenX, screenY);
}

function getChainAbs(win: WindowInfo): { x: number; y: number } {
    return getAbsoluteWindowPosition(win);
}

function hitTestSystemControlAtScreen(
    hwnd: number,
    screenX: number,
    screenY: number,
    visited: Set<number> = new Set<number>(),
): WindowInfo | undefined {
    if (visited.has(hwnd)) return undefined;
    visited.add(hwnd);

    const win = windows.get(hwnd);
    if (!win || !win.visible || !win.children.length) return undefined;

    for (let i = 0; i < win.children.length; i++) {
        const child = windows.get(win.children[i]);
        if (!child || !child.visible) continue;

        const { x: absX, y: absY } = getChainAbs(child);
        if (screenX < absX || screenY < absY || screenX >= absX + child.width || screenY >= absY + child.height) {
            continue;
        }

        const deeper = hitTestSystemControlAtScreen(child.handle, screenX, screenY, visited);
        if (deeper) return deeper;
        if (child.isSystemControl && !isGroupBoxSystemControl(child)) return child;
    }

    return undefined;
}
