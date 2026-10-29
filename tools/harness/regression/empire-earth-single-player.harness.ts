/**
 * Empire Earth 2.00 and The Art of Conquest (owned copies repacked locally) single player,
 * end to end — both share the menus and the first Learning Scenario:
 *
 *  - boot to the main menu and enter the first Learning Scenario;
 *  - the in-game world is lit, not black behind a working HUD;
 *  - a lasso selects the tutorial's citizens and a right-click moves them;
 *  - Save Game writes a save into the guest's Saved Games directory;
 *  - Quit this Game > Yes reaches the statistics screen with no guest fault;
 *  - a fresh worker loads that save back into a lit world, and the save file is read.
 *
 * The game draws its own cursor from relative DirectInput motion, at a gain that depends on
 * the frame rate, so every click aims closed-loop. The cursor sprite is captured from the
 * running game when the menu first appears (it starts at the screen centre) — no game pixels
 * are stored here — and found again in every shot.
 *
 * Prereqs: `bun tools/harness.ts up`. WGB = the repacked bundle. EE_ROOT = the guest install
 * directory: default "C:/EMPIRE EARTH"; for The Art of Conquest,
 * "C:/Empire Earth - The Art of Conquest". Writes evidence to logs/<BS_TAB>/empire-earth-sp/.
 * The run owns one save, `0bsregress`: it removes the previous run's copy before saving.
 */
import { mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { harness, closeHarnessConnection } from "../../harness";
import { decodePng } from "../../png-diff";

const wgb = process.env.WGB;
if (!wgb) throw new Error("WGB must point to the repacked Empire Earth bundle (a local owned copy)");
const EE_ROOT = process.env.EE_ROOT ?? "C:/EMPIRE EARTH";
const SAVE_NAME = "0bsregress";
const SAVE_PATH = `${EE_ROOT}/data/Saved Games/${SAVE_NAME}.ees`;
const out = resolve("logs", process.env.BS_TAB ?? "empire-earth-sp", "empire-earth-sp");
mkdirSync(out, { recursive: true });

// Guest coordinates, 1024x768.
const UI = {
    singlePlayer: [512, 264], learning: [749, 553], start: [250, 716], go: [810, 688],
    // The first tutorial opens on the town with its three citizens in this box.
    lasso: [625, 285, 715, 365], moveTo: [720, 420],
    gameMenu: [22, 12], saveGame: [371, 208], saveName: [540, 85], saveButton: [511, 725],
    quit: [511, 93], yes: [448, 476], playSaved: [749, 449], firstSave: [193, 111], load: [511, 725],
} as const;
const WORLD = { x0: 120, y0: 40, x1: 880, y1: 520 };
const UNIT_PANEL = { x0: 0, y0: 548, x1: 160, y1: 630 };
const RESOURCE_BAR = { x0: 200, y0: 702, x1: 820, y1: 718 };
const GW = 1024, GH = 768;

type Chain = ReturnType<typeof harness>;
interface Frame { data: Uint8Array }  // GW*GH RGB, guest pixels
interface Rect { x0: number; y0: number; x1: number; y1: number }

let shotSeq = 0;
function fail(msg: string): never { throw new Error(msg); }

async function step(what: string, chain: Chain): Promise<Record<string, any>> {
    const r = await chain.run();
    if (!r.ok) fail(`${what}: ${JSON.stringify(r.error)}`);
    return r.named as Record<string, any>;
}

/** Shot, in guest pixels. The checks read the presenter's own frame, the guest's pixels before
 *  the host scales them to the canvas: on a canvas a few pixels larger than the guest, the
 *  smoothed scaling blends the hard-edged cursor differently at every position. A labelled
 *  shot also saves the composited screen, what the user sees, as evidence. Where the presenter
 *  has no separate frame, the screen is scaled back to guest pixels. */
async function capture(label?: string): Promise<Frame> {
    if (label) {
        const screen = (await step("shot", harness().shot())).shot as { base64: string };
        await Bun.write(resolve(out, `${String(++shotSeq).padStart(2, "0")}-${label}.png`), Buffer.from(screen.base64, "base64"));
    }
    const layer = await harness().shot({ source: "layer" }).run();
    const shot = (layer.ok ? layer.named : await step("shot", harness().shot())).shot as { base64: string };
    const png = decodePng(new Uint8Array(Buffer.from(shot.base64, "base64")));
    const data = new Uint8Array(GW * GH * 3);
    for (let y = 0; y < GH; y++) {
        const sy = Math.min(png.height - 1, Math.floor((y + 0.5) * png.height / GH));
        for (let x = 0; x < GW; x++) {
            const sx = Math.min(png.width - 1, Math.floor((x + 0.5) * png.width / GW));
            const s = (sy * png.width + sx) * 4, d = (y * GW + x) * 3;
            data[d] = png.data[s]!; data[d + 1] = png.data[s + 1]!; data[d + 2] = png.data[s + 2]!;
        }
    }
    return { data };
}

/** Share of pixels brighter than near-black. */
function lit(f: Frame, r: Rect): number {
    let n = 0, total = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
        const i = (y * GW + x) * 3;
        if (f.data[i]! + f.data[i + 1]! + f.data[i + 2]! > 48) n++;
        total++;
    }
    return n / total;
}

function meanDiff(a: Frame, b: Frame, r: Rect): number {
    let sum = 0, total = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
        const i = (y * GW + x) * 3;
        sum += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
        total++;
    }
    return sum / total;
}

// ── the game's cursor ───────────────────────────────────────────────────────────────
const T = 32;  // template window; its origin is the arrow's tip, the hotspot
let tpl: Float32Array | null = null, mask: Uint8Array | null = null, maskCount = 0;

/** One relative move per guest frame: a title polling once per frame sees each on its own. */
function moves(chain: Chain, ux: number, uy: number, stepUnits = 10): Chain {
    for (const [axis, total] of [[0, ux], [1, uy]] as const) {
        let left = total;
        while (left) {
            const s = Math.max(-stepUnits, Math.min(stepUnits, left));
            chain = chain.moveRelative(axis === 0 ? s : 0, axis === 1 ? s : 0).tickFrames(2);
            left -= s;
        }
    }
    return chain;
}

async function captureCursor(): Promise<void> {
    // The menu's cursor gain follows its frame rate (a fraction of a pixel per unit at
    // menu speed) and it drops motion while still loading, so move in batches until the
    // change at the centre stops growing: the sprite has then left the window entirely.
    const cx = GW / 2, cy = GH / 2;
    const a = await capture();
    let last = -1;
    for (let batch = 0; batch < 40; batch++) {
        await step("move cursor aside", moves(harness(), 300, 0, 30).sleep(200));
        const b = await capture();
        tpl = new Float32Array(T * T * 3); mask = new Uint8Array(T * T); maskCount = 0;
        for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
            const i = ((cy + y) * GW + cx + x) * 3;
            const d = Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
            for (let c = 0; c < 3; c++) tpl[(y * T + x) * 3 + c] = a.data[i + c]!;
            if (d > 60) { mask[y * T + x] = 1; maskCount++; }
        }
        const moved = maskCount >= 40 && maskCount === last ? findCursor(b) : null;
        if (moved && moved.x >= cx + T) {
            // Keep only the pixels that look the same over both backgrounds: the opaque
            // arrow. Blended edges carry the backdrop they were captured on.
            let kept = 0;
            for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
                const k = y * T + x;
                if (!mask[k]) continue;
                const i = ((moved.y + y) * GW + moved.x + x) * 3;
                const d = Math.abs(tpl[k * 3]! - b.data[i]!) + Math.abs(tpl[k * 3 + 1]! - b.data[i + 1]!) + Math.abs(tpl[k * 3 + 2]! - b.data[i + 2]!);
                if (d > 45) mask[k] = 0; else kept++;
            }
            maskCount = kept;
            if (kept < 40) break;
            await Bun.write(resolve(out, "cursor-template.json"), JSON.stringify({ maskCount, found: findCursor(b) }));
            return;
        }
        last = maskCount;
    }
    fail(`could not capture the game cursor at the screen centre (${maskCount} changed pixels); ` +
         `the menu did not show it there, or it did not follow relative motion`);
}

/** Masked SSD over the whole frame. Returns the hotspot and its score. Near the right and
 *  bottom edges only the part of the sprite still on screen is compared. */
function findCursor(f: Frame): { x: number; y: number; score: number } {
    const t = tpl!, m = mask!;
    const idx: number[] = [];
    for (let k = 0; k < T * T; k++) if (m[k]) idx.push(k);
    const at = (px: number, py: number, best: number): number => {
        let s = 0, n = 0;
        for (const k of idx) {
            const ty = (k / T) | 0, tx = k - ty * T;
            if (px + tx >= GW || py + ty >= GH) continue;
            const i = ((py + ty) * GW + px + tx) * 3, j = k * 3;
            const d0 = f.data[i]! - t[j]!, d1 = f.data[i + 1]! - t[j + 1]!, d2 = f.data[i + 2]! - t[j + 2]!;
            s += d0 * d0 + d1 * d1 + d2 * d2; n++;
            // The running best bounds each sum, so almost every offset stops after a few pixels.
            if (s > best * idx.length) return Infinity;
        }
        return n * 2 >= idx.length ? s / n : Infinity;
    };
    // Every offset: the arrow is a hard-edged sprite, and one pixel off scores like a miss.
    let best = { x: 0, y: 0, s: Infinity };
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
        const s = at(x, y, best.s);
        if (s < best.s) best = { x, y, s };
    }
    return { x: best.x, y: best.y, score: best.s };
}

const LOST = 3000;
/** The menu cursor eases toward its input, and keeps moving after the input stops; the
 *  next look waits for it to come to rest. */
const SETTLE_MS = 700;
const gain = [0.5, 0.5];

/** Find the cursor; if it is out of view, push it toward the top-left corner, where the
 *  menus clamp it, until it shows. */
async function locate(): Promise<{ x: number; y: number; score: number }> {
    let p = findCursor(await capture());
    for (let batch = 0; batch < 12 && p.score > LOST; batch++) {
        // One axis at a time: the game's response to a combined (dx, dy) is not the sum
        // of its responses to each axis.
        let chain = harness();
        for (let k = 0; k < 40; k++) chain = chain.moveRelative(-40, 0).tickFrames(1);
        for (let k = 0; k < 40; k++) chain = chain.moveRelative(0, -40).tickFrames(1);
        await step("bring the cursor into view", chain.sleep(SETTLE_MS * 2));
        p = findCursor(await capture());
    }
    return p;
}

async function aim(tx: number, ty: number, tol = 4): Promise<void> {
    let p = await locate();
    for (let i = 0; i < 40; i++) {
        if (p.score > LOST) {
            await capture(`lost-at-${tx}-${ty}`);
            fail(`lost the game cursor while aiming at (${tx},${ty}) (score ${p.score.toFixed(0)})`);
        }
        const ex = tx - p.x, ey = ty - p.y;
        if (Math.abs(ex) <= tol && Math.abs(ey) <= tol) return;
        // The gain differs per axis and drifts with the frame rate, so every aim starts with
        // a short measured probe and then closes 70% of the remaining distance per step:
        // the menus do not clamp at the right or bottom edge, and an overshoot there takes
        // the cursor out of view.
        const cap = i === 0 ? 60 : 3000;
        const unitsFor = (e: number, g: number) => e === 0 ? 0
            : Math.max(-cap, Math.min(cap, Math.sign(e) * Math.max(1, Math.round(Math.abs(e) * (Math.abs(e) <= 8 ? 1 : 0.7) / g))));
        const ux = unitsFor(ex, gain[0]!), uy = unitsFor(ey, gain[1]!);
        await step("aim", moves(harness(), ux, uy, 30).sleep(SETTLE_MS));
        const seen = findCursor(await capture());
        if (seen.score > LOST) {
            // Overshot out of view: the gain was underestimated. Recover at the corner.
            gain[0] = Math.min(4, gain[0]! * 3); gain[1] = Math.min(4, gain[1]! * 3);
            p = await locate();
            continue;
        }
        if (Math.abs(ux) >= 20 && seen.x !== p.x) gain[0] = Math.max(0.02, Math.min(4, 0.5 * gain[0]! + 0.5 * (seen.x - p.x) / ux));
        if (Math.abs(uy) >= 20 && seen.y !== p.y) gain[1] = Math.max(0.02, Math.min(4, 0.5 * gain[1]! + 0.5 * (seen.y - p.y) / uy));
        p = seen;
    }
    fail(`cursor did not settle on (${tx},${ty}); last seen at (${p.x},${p.y})`);
}

async function click(at: readonly number[], settleMs: number, button = 0): Promise<void> {
    await aim(at[0]!, at[1]!);
    await step("click", harness().clickHere(250, button).sleep(settleMs));
}

async function waitForLitWorld(what: string, timeoutMs: number): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    let f = await capture(), share = lit(f, WORLD);
    while (Date.now() < deadline) {
        // In the world: the resource bar is drawn and the view is partly fog (a briefing or
        // loading screen is lit edge to edge).
        if (share > 0.25 && share < 0.95 && lit(f, RESOURCE_BAR) > 0.5) return f;
        await step("wait", harness().sleep(3000));
        f = await capture(); share = lit(f, WORLD);
    }
    await capture(`${what}-timeout`);
    fail(`${what}: the world never lit (lit share ${share.toFixed(2)})`);
}

async function guestHealth(what: string): Promise<void> {
    const named = await step("report", harness().state(["screen"]).sleep(2000).state(["screen"]).report());
    const r = named.report as { crash: unknown; faults: unknown[]; stubs: unknown[] };
    if (r.crash || (r.faults ?? []).length) fail(`${what}: guest fault ${JSON.stringify(r.faults ?? r.crash).slice(0, 400)}`);
    if ((r.stubs ?? []).length) fail(`${what}: unimplemented API ${JSON.stringify(r.stubs).slice(0, 400)}`);
}

async function bootToMenu(): Promise<void> {
    await step("boot", harness().openWgb(wgb!).sleep(25_000)
        .key("Escape").sleep(4000).key("Escape").sleep(12_000));
}

try {
    // 1. Main menu → first Learning Scenario → lit world.
    await bootToMenu();
    await step("drop the previous run's save", harness().fsDelete(SAVE_PATH));
    await captureCursor();
    await click(UI.singlePlayer, 5000);
    await click(UI.learning, 12_000);
    await click(UI.start, 25_000);
    await click(UI.go, 30_000);
    await waitForLitWorld("tutorial", 150_000);
    await capture("world");
    await guestHealth("tutorial world");

    // 2. Unit control in the opening view: lasso the citizens, order a move.
    const beforeSelect = await capture("before-select");
    const [x0, y0, x1, y1] = UI.lasso;
    await aim(x0, y0);
    await step("lasso", moves(harness().clickHere(3000, 0).tickFrames(2), Math.round((x1 - x0) / gain[0]!), Math.round((y1 - y0) / gain[1]!)).sleep(3500));
    const selected = await capture("selected");
    const panel = meanDiff(beforeSelect, selected, UNIT_PANEL);
    if (panel < 20) fail(`lasso selected nothing: the unit panel did not appear (diff ${panel.toFixed(1)})`);
    await click(UI.moveTo, 6000, 1);
    const moved = await capture("moved");
    const box = { x0, y0, x1, y1 };
    const left = meanDiff(selected, moved, box);
    if (left < 8) fail(`move order ignored: nothing changed where the selected units stood (diff ${left.toFixed(1)})`);

    // 3. Save Game.
    await click(UI.gameMenu, 2500);
    await click(UI.saveGame, 3000);
    await click(UI.saveName, 800);
    // The field opens holding the last name used; clear it before typing. Editing keys
    // are read from key state, which a same-tick tap never shows, so each one is held.
    let clear = harness().keyHold("End", 80).sleep(120);
    for (let k = 0; k < 40; k++) clear = clear.keyHold("Backspace", 60).sleep(90);
    await step("type save name", clear.sleep(300).type(SAVE_NAME).sleep(1000));
    await capture("save-dialog");
    await click(UI.saveButton, 6000);
    const st = (await step("fsStat", harness().fsStat(SAVE_PATH))).fsStat as { exists?: boolean; size?: number } | null;
    if (!st || st.exists === false || (st.size ?? 0) < 8192) fail(`Save Game wrote no save at ${SAVE_PATH}: ${JSON.stringify(st)}`);

    // 4. Quit this Game > Yes > statistics.
    const world = await capture("before-quit");
    await click(UI.gameMenu, 2500);
    await click(UI.quit, 2500);
    await click(UI.yes, 8000);
    await guestHealth("quit to statistics");
    const stats = await capture("statistics");
    if (meanDiff(world, stats, { x0: 0, y0: 0, x1: GW, y1: GH }) < 40) fail("Quit > Yes did not leave the game world");

    // 5. Fresh worker: load the save back.
    await bootToMenu();
    await click(UI.singlePlayer, 5000);
    await click(UI.playSaved, 5000);
    await capture("saved-games");
    await click(UI.firstSave, 1500);
    await step("io reset", harness().call("fsIoReport", { reset: true, top: 1 }));
    await click(UI.load, 30_000);
    await waitForLitWorld("loaded save", 150_000);
    await capture("loaded");
    const io = (await step("io", harness().call("fsIoReport", { top: 400, sort: "reads" }))).fsIoReport as
        { enabled: boolean; top: Array<{ path: string; reads: number }> };
    if (!io.enabled) fail("file I/O census is disabled; cannot tell which save was loaded");
    const saveName = `${SAVE_NAME}.ees`.toLowerCase();
    if (!io.top.some((r) => r.path.toLowerCase().endsWith(saveName) && r.reads > 0)) {
        fail(`Load did not read ${SAVE_PATH}`);
    }
    await guestHealth("loaded save");
    console.log(`OK — Empire Earth single player: lit tutorial world, unit selection and move, save, ` +
                `quit to statistics, fresh-worker load; evidence: ${relative(process.cwd(), out)}`);
} finally {
    closeHarnessConnection();
}
