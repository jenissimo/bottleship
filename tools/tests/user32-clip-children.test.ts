import { beforeEach, describe, expect, test } from 'bun:test';
import { getChildWindowExclusions, windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';

const WS_CHILD = 0x40000000;
const WS_CLIPCHILDREN = 0x02000000;

const PARENT = 0x10001;
const CHILD = 0x10002;
const HOST = 0x10003;
const GRANDCHILD = 0x10004;

function win(handle: number, over: Partial<WindowInfo> = {}): WindowInfo {
    return {
        handle,
        title: '',
        style: WS_CHILD,
        x: 0,
        y: 0,
        width: 40,
        height: 20,
        children: [],
        visible: true,
        wndProc: 0x401000,
        ...over,
    };
}

/** Stands in for the EndPaint chain's "this child repaints itself over me" predicate. */
const restampsEverything = () => true;

describe('getChildWindowExclusions', () => {
    beforeEach(() => windows.clear());

    test('a parent WITHOUT WS_CLIPCHILDREN paints under a child the caller restamps', () => {
        windows.set(PARENT, win(PARENT, { style: 0, children: [CHILD] }));
        windows.set(CHILD, win(CHILD, { parent: PARENT }));

        expect(getChildWindowExclusions(PARENT)).toHaveLength(1);
        expect(getChildWindowExclusions(PARENT, { repaintedAfterFlush: restampsEverything }))
            .toHaveLength(0);
    });

    test('WS_CLIPCHILDREN keeps the hole even when the caller would restamp', () => {
        windows.set(PARENT, win(PARENT, { style: WS_CLIPCHILDREN, children: [CHILD] }));
        windows.set(CHILD, win(CHILD, { parent: PARENT }));

        expect(getChildWindowExclusions(PARENT, { repaintedAfterFlush: restampsEverything }))
            .toHaveLength(1);
    });

    test('a child nobody restamps stays excluded whatever the parent style says', () => {
        windows.set(PARENT, win(PARENT, { style: 0, children: [CHILD] }));
        windows.set(CHILD, win(CHILD, { parent: PARENT }));

        expect(getChildWindowExclusions(PARENT, { repaintedAfterFlush: () => false }))
            .toHaveLength(1);
    });

    test('system controls are never excluded, but guest windows nested under them are', () => {
        windows.set(PARENT, win(PARENT, { style: 0, children: [HOST] }));
        windows.set(HOST, win(HOST, {
            parent: PARENT, isSystemControl: true, systemControlClass: 'Static',
            children: [GRANDCHILD],
        }));
        // Geometry distinct from HOST's, so the returned rect names WHICH window was
        // excluded: an equally-sized hole would pass whether the walk descended or
        // stopped at the system control it must never exclude.
        windows.set(GRANDCHILD, win(GRANDCHILD, { parent: HOST, x: 5, y: 5, width: 10, height: 10 }));

        // The restamp chain only reaches DIRECT children, so a grandchild keeps its hole.
        expect(getChildWindowExclusions(PARENT, { repaintedAfterFlush: restampsEverything }))
            .toEqual([{ x: 5, y: 5, w: 10, h: 10 }]);
    });

    test('a restamped child that itself hosts guest windows keeps its hole', () => {
        windows.set(PARENT, win(PARENT, { style: 0, children: [CHILD] }));
        windows.set(CHILD, win(CHILD, { parent: PARENT, children: [GRANDCHILD] }));
        windows.set(GRANDCHILD, win(GRANDCHILD, { parent: CHILD, width: 10, height: 10 }));

        expect(getChildWindowExclusions(PARENT, { repaintedAfterFlush: restampsEverything }))
            .toHaveLength(1);
    });
});
