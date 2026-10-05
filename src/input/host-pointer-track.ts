/**
 * Windows has ONE pointer position: SetCursorPos WRITES it, and hardware motion is
 * ADDED to it. The browser gives us only the second half — the absolute position of a
 * pointer we are not allowed to write — so a guest warp is undone by the very next
 * pointermove, and a title that emulates a relative mouse (read the position, subtract
 * a fixed centre, SetCursorPos back to that centre) computes a delta that grows with
 * how far the physical pointer has drifted from the centre rather than with how far it
 * just moved.
 *
 * Pointer Lock is the transport that fixes this properly: the browser then reports
 * motion directly and the physical pointer cannot drift at all. This is what the guest
 * gets while the lock is NOT held — refused, not yet granted after a gesture, released
 * with Esc, or an unfocused window: the host pointer is read as a MOTION source, and
 * the pointer position stays what the guest last set plus the motion observed since.
 *
 * With no warp in play the guest's cursor is always exactly the last host position, so
 * `cursor + (host - lastHost)` IS `host`: every title that never warps sees the same
 * stream of positions it saw before, value for value.
 */

export interface HostPoint { x: number; y: number }
/** right/bottom EXCLUSIVE, as in Win32 RECT. */
export interface ConfineRect { left: number; top: number; right: number; bottom: number }

export class HostPointerTrack {
    private last: HostPoint | null = null;
    private confine: ConfineRect | null = null;

    /**
     * ClipCursor confinement, or null when nothing confines the pointer.
     *
     * The guest's own clamp is not enough on its own: the HOST pointer is a second,
     * unconfined pointer, so once it walks past the wall the two diverge by the whole
     * excursion and coming back has to retrace it before anything moves. Pointer Lock
     * removes the second pointer entirely and is the real transport; this is what makes
     * the unlocked fallback (lock refused, released with Esc, unfocused) behave like the
     * one-pointer world the guest is written for — the same position the guest clamps to,
     * so the drawn pointer and the guest's agree, and a reversal moves it immediately.
     */
    setConfine(rect: ConfineRect | null): void {
        this.confine = rect;
    }

    /**
     * Motion is only observable while the pointer is over the picture. A gap (it left,
     * or a sample landed outside) means we cannot honestly say what motion happened, so
     * the next sample re-seats the guest's pointer at the host's position instead of
     * inventing a delta across the gap.
     */
    lose(): void {
        this.last = null;
    }

    /**
     * Where the guest's pointer belongs after this host sample.
     *
     * @param host    host pointer in guest space
     * @param cursor  where the guest's pointer is NOW — the guest's own SetCursorPos
     *                moves this, and the host pointer does not follow
     * @param bounds  the guest space; a sample outside it is a lost track, because the
     *                published position is clamped there and a delta taken against a
     *                clamped value would drift by exactly what the clamp removed
     */
    next(host: HostPoint, cursor: HostPoint, bounds: HostPoint): HostPoint {
        const outside = host.x < 0 || host.y < 0 || host.x > bounds.x || host.y > bounds.y;
        const prev = outside ? null : this.last;
        this.last = outside ? null : host;
        const target = prev
            ? { x: cursor.x + (host.x - prev.x), y: cursor.y + (host.y - prev.y) }
            : { x: host.x, y: host.y };
        return this.clamp(target);
    }

    /** wineserver update_desktop_cursor_pos / NT5 BoundCursor: right/bottom exclusive. */
    private clamp(p: HostPoint): HostPoint {
        const c = this.confine;
        if (!c) return p;
        return {
            x: Math.max(Math.min(p.x, c.right - 1), c.left),
            y: Math.max(Math.min(p.y, c.bottom - 1), c.top),
        };
    }
}
