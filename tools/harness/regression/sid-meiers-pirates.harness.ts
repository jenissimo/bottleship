/**
 * Sid Meier's Pirates! (2004, Gamebryo + D3D9): boot reaches the menu, New Game reaches
 * gameplay, with the scheduler invariants that used to wedge the loader armed:
 *
 *  - the background loader spawns short-lived task threads through the whole boot; the
 *    reaper must return their stacks (no CreateThread failure — a failed CreateThread
 *    leaves the loader waiting on a task that can never run, and the title freezes);
 *  - joining a worker whose thread was already reaped must satisfy (a join that never
 *    wakes left the game's thread-stop machinery parked forever) — the boot completing
 *    to gameplay is the observable; the unit tests pin the wait semantics;
 *  - the menu is game-rendered (no Win32 controls): the drive-in is a coordinate click.
 *
 * Every check fails when the piece it guards is missing; a piece never observed fails
 * as "not judged" instead of passing.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { harness, closeHarnessConnection } from "../../harness";
import { decodePng } from "../../png-diff";

const wgb = process.env.WGB;
if (!wgb) throw new Error("WGB must point to the repacked Sid Meier's Pirates! bundle");
const out = resolve("logs", process.env.BS_TAB ?? "sid-meiers-pirates", "sid-meiers-pirates");
mkdirSync(out, { recursive: true });

/** The main-menu items are engine-drawn (guest 800x600): "Play Sid Meier's Pirates!". */
const PLAY = { x: 405, y: 133 };
const BOOT_TO_MENU_MS = 180_000;
const MENU_TO_GAME_MS = 180_000;

interface Screen { width: number; height: number; presentSerial: number }
interface Png { width: number; height: number; data: Uint8Array }

async function step(what: string, chain: ReturnType<typeof harness>): Promise<Record<string, unknown>> {
    const r = await chain.run();
    if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
    return r.named as Record<string, unknown>;
}

async function screen(): Promise<Screen> {
    return ((await step("state", harness().state(["screen"]))).state as { screen: Screen }).screen;
}

async function capture(label: string): Promise<Png> {
    const shot = (await step(label, harness().shot())).shot as { base64: string };
    const bytes = Buffer.from(shot.base64, "base64");
    await Bun.write(resolve(out, `${label}.png`), bytes);
    return decodePng(new Uint8Array(bytes));
}

/** Share of non-black pixels in the rectangle given as fractions of the picture. */
function lit(png: Png, x0: number, y0: number, x1: number, y1: number): number {
    let n = 0, total = 0;
    for (let y = Math.floor(y0 * png.height); y < Math.floor(y1 * png.height); y++) {
        for (let x = Math.floor(x0 * png.width); x < Math.floor(x1 * png.width); x++) {
            const i = (y * png.width + x) * 4;
            if (png.data[i]! + png.data[i + 1]! + png.data[i + 2]! > 24) n++;
            total++;
        }
    }
    return total ? n / total : 0;
}

async function waitFor(what: string, timeoutMs: number, test: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await test()) return;
        await step("poll", harness().sleep(5_000));
    }
    throw new Error(`not judged: ${what} never became true within ${timeoutMs}ms`);
}

const failures: string[] = [];
try {
    // Enlarge the log ring BEFORE the boot so a late CreateThread failure is retained.
    await step("ring", harness().logRing(50_000));
    await step("load", harness().openWgb(wgb));

    let menuPng: Png | null = null;
    await waitFor("main menu renders", BOOT_TO_MENU_MS, async () => {
        menuPng = await capture("menu-poll");
        if (lit(menuPng, 0.15, 0.1, 0.85, 0.75) < 0.15) return false;
        // The menu animates its clouds — a frozen frame is a wedge, not a menu.
        const s1 = await screen();
        await step("tick", harness().sleep(3_000));
        const s2 = await screen();
        return s2.presentSerial > s1.presentSerial;
    });
    if (!menuPng || lit(menuPng, 0.15, 0.1, 0.85, 0.75) < 0.15) {
        failures.push("menu never rendered enough lit pixels");
    }

    await step("play", harness().clickAt(PLAY.x, PLAY.y));

    let gamePng: Png | null = null;
    await waitFor("gameplay renders after New Game", MENU_TO_GAME_MS, async () => {
        gamePng = await capture("game-poll");
        // The tavern cutscene fills the frame; the menu was centre-weighted, the game is not.
        return lit(gamePng, 0.05, 0.05, 0.95, 0.95) > 0.25;
    });
    if (!gamePng || lit(gamePng, 0.05, 0.05, 0.95, 0.95) < 0.25) {
        failures.push("gameplay never rendered enough lit pixels");
    }

    // The stack-exhaustion guard: any CreateThread failure is the wedge coming back.
    const recent = (await step("logs", harness().logs(50_000, "createthread"))) as
        { entries?: Array<{ message?: string }> };
    const createThreadFailures = (recent.entries ?? []).filter(e => (e.message ?? "").includes("CreateThread failed"));
    if (createThreadFailures.length > 0) {
        failures.push(`CreateThread failed ${createThreadFailures.length}x — the stack-reap invariant broke`);
    }

    if (failures.length > 0) {
        console.error(`[sid-meiers-pirates] FAILED:\n  - ${failures.join("\n  - ")}`);
        process.exitCode = 1;
    } else {
        console.log("[sid-meiers-pirates] OK: menu → New Game → gameplay, no CreateThread failures");
    }
} finally {
    closeHarnessConnection();
}
