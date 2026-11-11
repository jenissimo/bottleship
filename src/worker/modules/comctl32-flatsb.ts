import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import {
    applyScrollInfo,
    getScrollBarState,
    getScrollPos,
    getScrollRange,
    readScrollInfo,
    setScrollBarState,
    setScrollPos,
    setScrollRange,
} from "./user32/scroll-state";

// @participant(comctl32)
const flatSbWindows = new Set<number>();
// @participant(comctl32)
const flatSbProps = new Map<number, Map<number, number>>();

export interface FlatSbState { windows: number[]; props: Array<[number, Array<[number, number]>]> }

export function captureFlatSbState(): FlatSbState {
    return { windows: [...flatSbWindows], props: [...flatSbProps].map(([hwnd, m]) => [hwnd, [...m]]) };
}

export function restoreFlatSbState(s: FlatSbState): void {
    flatSbWindows.clear();
    flatSbProps.clear();
    for (const hwnd of s.windows) flatSbWindows.add(hwnd);
    for (const [hwnd, rows] of s.props) flatSbProps.set(hwnd, new Map(rows));
}

function propsFor(hwnd: number): Map<number, number> {
    let m = flatSbProps.get(hwnd);
    if (!m) {
        m = new Map();
        flatSbProps.set(hwnd, m);
    }
    return m;
}

export function registerFlatSbExports(exports: Record<string, ThunkImplementation>): void {
    exports["InitializeFlatSB"] = (_ctx, _mem, args) => {
        flatSbWindows.add(args[0] >>> 0);
        return 1;
    };

    exports["UninitializeFlatSB"] = (_ctx, _mem, args) => {
        const hwnd = args[0] >>> 0;
        flatSbWindows.delete(hwnd);
        flatSbProps.delete(hwnd);
        return 1;
    };

    exports["FlatSB_EnableScrollBar"] = (_ctx, _mem, args) => {
        const hwnd = args[0] >>> 0;
        const bar = args[1] | 0;
        const flags = args[2] >>> 0;
        const state = getScrollBarState(hwnd, bar);
        state.enabled = (flags & 3) !== 3;
        setScrollBarState(hwnd, bar, state);
        return 1;
    };

    exports["FlatSB_ShowScrollBar"] = (_ctx, _mem, args) => {
        const hwnd = args[0] >>> 0;
        const bar = args[1] | 0;
        const show = args[2] >>> 0;
        const state = getScrollBarState(hwnd, bar);
        state.visible = show !== 0;
        setScrollBarState(hwnd, bar, state);
        return 1;
    };

    exports["FlatSB_GetScrollRange"] = (_ctx, mem, args) =>
        getScrollRange(mem, args[0] >>> 0, args[1] | 0, args[2] >>> 0, args[3] >>> 0) ? 1 : 0;

    exports["FlatSB_SetScrollRange"] = (_ctx, _mem, args) => {
        const hwnd = args[0] >>> 0;
        const bar = args[1] | 0;
        setScrollRange(hwnd, bar, args[2] | 0, args[3] | 0);
        return 1;
    };

    exports["FlatSB_GetScrollPos"] = (_ctx, _mem, args) =>
        getScrollPos(args[0] >>> 0, args[1] | 0);

    exports["FlatSB_SetScrollPos"] = (_ctx, _mem, args) =>
        setScrollPos(args[0] >>> 0, args[1] | 0, args[2] | 0);

    exports["FlatSB_GetScrollInfo"] = (_ctx, mem, args) =>
        readScrollInfo(mem, args[0] >>> 0, args[1] | 0, args[2] >>> 0) ? 1 : 0;

    exports["FlatSB_SetScrollInfo"] = (_ctx, mem, args) =>
        applyScrollInfo(mem, args[0] >>> 0, args[1] | 0, args[2] >>> 0);

    exports["FlatSB_GetScrollProp"] = (_ctx, _mem, args) => {
        const hwnd = args[0] >>> 0;
        const index = args[1] >>> 0;
        const pValue = args[2] >>> 0;
        if (!pValue) return 0;
        const value = propsFor(hwnd).get(index) ?? 0;
        Mem.writeUint32(pValue, value);
        return 1;
    };

    exports["FlatSB_SetScrollProp"] = (_ctx, _mem, args) => {
        const hwnd = args[0] >>> 0;
        const index = args[1] >>> 0;
        const value = args[2] >>> 0;
        propsFor(hwnd).set(index, value);
        return 1;
    };
}

export function resetFlatSbState(): void {
    flatSbWindows.clear();
    flatSbProps.clear();
}
