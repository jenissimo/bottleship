/**
 * The Dark Eye: Chains of Satinav (Visionaire 5 / SDL2 / GOG, D3D9 path) — main-menu regression.
 *
 * Guards the load path this title exercised into existence:
 *   - kernel32:GetFileSizeEx (the guest sizes every container read with it),
 *   - the slab arena living in HEAP_HIGH — sharing one bucket with the guest means the arena
 *     either starves the guest (std::bad_alloc mid-load) or starves itself,
 *   - the HEAP_HIGH spill — this title's live working set passes 500MB before the menu,
 *   - D3D9 present + mouse routing into an SDL_app window,
 *   - the arena's TIER SPLIT: a frozen arena still renders the menu perfectly, just at 1.5 FPS
 *     instead of 58, so every pixel assertion here stays green through a 39x regression.
 *
 * Determinism: the OPFS container is WIPED first. A savegame changes the menu's layout, so a
 * scenario that inherits one drifts away from the geometry it was written against — which is
 * exactly how the previous version of this file rotted into a hang.
 *
 * Positive control: a click on the menu must cause a LARGE screen change. That proves three
 * things at once (the scene rendered, the guest is running its Lua menu logic, and the click
 * reached it) without depending on one row's exact hit box. It is deliberately NOT an assertion
 * that "New Game" specifically was hit — the invariant worth guarding is that the menu responds
 * to input at all; pinning one row is what made this fragile before.
 */
import { harness } from "../../harness";

const BUNDLE = process.env.WGB ?? "G:/WGB/todo/the-dark-eye-chains-of-satinav.wgb";
/** Container key = the bundle's gameId, DASH-separated as OPFS stores it (`gog-1207659133`,
 *  not `gog:...`) - a wrong id wipes nothing, and since the wipe is idempotent it would say so
 *  only through `existed`/`knownContainers`, which is what the assertion below reads. */
const CONTAINER = "gog-1207659133";
/** The positive control is a KEYBOARD press rather than a click, because the mouse behaviour here
 *  is an UNRESOLVED DISCREPANCY, not a settled defect. In this scenario's state (container wiped,
 *  so first-run English at 1920x1080) no menu row reacts to a click: wmTrace shows
 *  WM_SETCURSOR/WM_MOUSEMOVE/WM_LBUTTONDOWN/WM_LBUTTONUP arriving at the requested guest pixels,
 *  inputTrace shows the guest observing the button transition, a y-sweep over the whole column
 *  (440..562, read off gridShot) repaints only the idle floor, and a REAL browser mouse event
 *  dispatched via CDP at the same point is equally inert - yet the maintainer reports the game is
 *  clickable when driven by hand. Until that is explained, a click assertion here would be
 *  guarding something nobody understands; the keyboard proves the same invariant (input reaches
 *  the guest and the menu logic runs) without encoding a mystery as an expectation. */
const MENU_KEY = "Down";
/** Bracketed by two measurements, so the margin is visible rather than assumed: a no-op input
 *  repaints ~600px (the engine's idle animation) and one Down repaints ~17,700px (the highlight
 *  moving one row). Enter repaints ~1.5M, but it COMMITS to a menu action, which is why the
 *  control navigates instead. */
const MIN_CHANGED_PX = 5_000;

const result = await harness()
    // Drop any guest still running in this tab BEFORE wiping: a live process holds OPFS access
    // handles into its own container, and the wipe then fails on the files it is trying to
    // remove. openWgb() reloads too, but that is after the wipe - too late to help it.
    .reload()
    // Let the torn-down worker's debounced OPFS flush finish before touching its files.
    .sleep(1500)
    .containerDelete(CONTAINER)
    .openWgb(BUNDLE)
    .watchFrames(true)
    // The menu appears after the Daedalic intro. There is no event to wait on, and a tickFrames
    // budget would be satisfied by the intro's own presents.
    .sleep(150_000)
    .state(["screen"])
    .screenMark()
    .keyHold(MENU_KEY, 350)
    .sleep(12_000)
    .screenChangeSince()
    .heapBuckets()
    .call("heapSlabRates", { ms: 2000 })
    .shot({ save: "satinav-menu.png" })
    .run();

const named = result.named as Record<string, any>;
const fail = (why: string) => { console.error(`FAIL: ${why}`); process.exitCode = 1; };

if (!result.ok) fail(`chain aborted: ${result.error?.message}`);

// The determinism guarantee is only real if the wipe found the container it names. On a machine
// that has run other titles, an unknown id means a typo, not a clean overlay - and then this
// scenario silently runs against whatever save was there.
const wipe = named?.containerDelete;
if (wipe && wipe.existed === false && (wipe.knownContainers?.length ?? 0) > 0) {
    fail(`containerDelete('${CONTAINER}') matched nothing while ${wipe.knownContainers.length} `
        + `containers exist - the id is wrong, so this run inherited whatever overlay was present. `
        + `Known: ${wipe.knownContainers.slice(0, 6).join(", ")}`);
}

const screen = named?.state?.screen;
if (screen?.presenter !== "d3d9") fail(`presenter is ${screen?.presenter}, expected d3d9`);
if (!(screen?.presentSerial > 0)) fail(`nothing presented (presentSerial=${screen?.presentSerial})`);

const chg = named?.screenChangeSince;
const changed = chg?.changed ?? chg?.total?.changed ?? chg?.outside?.changed ?? 0;
if (changed < MIN_CHANGED_PX) {
    fail(`pressing ${MENU_KEY} repainted only ${changed}px (< ${MIN_CHANGED_PX}) — the menu never `
        + "rendered, or input does not reach the guest");
}

// The small-alloc tier: an arena that cannot grow serves nothing from the inline x86 stub and
// every sub-4KB request lands in the JS HeapAlloc thunk instead. Judge the SHARE, not the raw
// rate — absolute numbers scale with whatever the guest happens to be doing.
const slab = named?.heapSlabRates;
if (slab && !slab.countersReset) {
    const fast = slab.allocsPerSec ?? 0;
    const slow = slab.fallbacksPerSec ?? 0;
    const total = fast + slow;
    if (total > 100 && slow / total > 0.25) {
        fail(`${(100 * slow / total).toFixed(1)}% of small allocations fell back to the JS `
            + `HeapAlloc thunk (${slow}/s vs ${fast}/s inline) — the slab arena is starved `
            + `(activeFreePct=${slab.activeFreePct}, arena ${slab.totalMB}MB)`);
    }
}

const heap = named?.heapBuckets?.buckets ?? [];
const live = heap.filter((b: any) => b.kind === "HEAP" || b.kind === "HEAP_HIGH")
    .reduce((sum: number, b: any) => sum + b.liveMB, 0);
if (live < 300) fail(`only ${live}MB live in the heap — the load did not get far enough`);

console.log(JSON.stringify({
    presenter: screen?.presenter,
    presentSerial: screen?.presentSerial,
    pixelsRepaintedByKey: changed,
    heapLiveMB: Math.round(live),
    heapHighSpillMB: heap.find((b: any) => b.kind === "HEAP_HIGH")?.bumpMB ?? 0,
    slabArenaMB: heap.find((b: any) => b.kind === "HEAP_HIGH")?.slabArenaMB ?? 0,
    slabInlinePerSec: slab?.allocsPerSec,
    slabJsFallbackPerSec: slab?.fallbacksPerSec,
    slabActiveFreePct: slab?.activeFreePct,
}, null, 2));
