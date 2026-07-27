/**
 * Pins the GDI-over-DirectDraw composite rule (dialogOverlayComposites).
 *
 * The rule is shared by EVERY GDI title, so it is stated as the DirectDraw
 * exclusive-fullscreen ownership contract, not as per-title heuristics — these
 * cases are the contract's truth table plus the live titles that exercise it.
 */
import { describe, expect, test } from 'bun:test';
import { dialogOverlayComposites, type DialogOverlayFacts } from '../../src/worker/modules/user32/dialog-overlay';

/** A live dialog group that would composite: every gate open. */
const composable: DialogOverlayFacts = {
    gdiOutputOnScreen: true,
    isScreenOwnerWindow: false,
    isDialogRoot: true,
    hasOverlayContent: true,
};

describe('dialogOverlayComposites', () => {
    test('composites a live modal while GDI output reaches the display', () => {
        // TS "Select Campaign" / BOD Setup: single-buffered primary (or windowed),
        // so GDI paints land in the memory being displayed.
        expect(dialogOverlayComposites(composable)).toBe(true);
    });

    test('never composites while a DirectDraw flip chain owns the screen', () => {
        // Worms Armageddon: full-screen #32770 of plain statics over a flipping
        // primary chain. On real Windows its GDI paint goes to the off-screen GDI
        // surface, so it must contribute nothing — the game's own frame is the screen.
        expect(dialogOverlayComposites({ ...composable, gdiOutputOnScreen: false })).toBe(false);
    });

    test('never composites the exclusive-fullscreen cooperative-level window', () => {
        // Its client area IS the primary — it is the game, not a plane above it.
        expect(dialogOverlayComposites({ ...composable, isScreenOwnerWindow: true })).toBe(false);
    });

    test('only the dialog root contributes a rect', () => {
        // A child control's pixels are already inside the root's visual bounds;
        // compositing it separately fights the game's own render of that control.
        expect(dialogOverlayComposites({ ...composable, isDialogRoot: false })).toBe(false);
    });

    test('a group the overlay holds no pixels for contributes nothing', () => {
        // TLJ's control-less, caption-less "#dialog" focus shell: the game draws the
        // message box into DirectDraw itself, so our render is pure occlusion.
        expect(dialogOverlayComposites({ ...composable, hasOverlayContent: false })).toBe(false);
    });

    test('the flip-chain gate is independent of the dialog content gates', () => {
        // Regression guard: a rich, root, non-owner dialog is STILL invisible behind a
        // flip chain — content signals must never re-open the ownership gate.
        for (const isDialogRoot of [true, false]) {
            for (const hasOverlayContent of [true, false]) {
                expect(dialogOverlayComposites({
                    ...composable, gdiOutputOnScreen: false, isDialogRoot, hasOverlayContent,
                })).toBe(false);
            }
        }
    });
});
