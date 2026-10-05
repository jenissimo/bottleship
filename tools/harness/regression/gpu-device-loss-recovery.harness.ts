/**
 * A lost WebGPU device must be survivable: recreate, re-upload, and tell the guest the truth.
 *
 * The failure this guards is silent by construction. A lost device does not throw — every
 * later call against it is a validated no-op — so the picture simply stops changing while
 * every counter we own keeps incrementing. Three things must hold, in order:
 *
 *   1. the loss is OBSERVED — a generation bump and a clean observer fan-out, not a log line,
 *   2. the picture COMES BACK — frames still reaching the canvas AND still changing, which is
 *      only true if every device-derived cache was invalidated and every restorable resource
 *      re-uploaded onto the new device,
 *   3. the guest was TOLD, at the one instant it was true. TestCooperativeLevel must have
 *      answered lost/notreset DURING the loss, never D3D_OK.
 *
 * (3) is the half that cannot be checked from the ends: once the run finishes, D3D_OK is the
 * honest answer again, so a build that never reported anything looks identical from outside.
 * The `during` snapshot is sampled from inside the invalidation fan-out for exactly that
 * reason. And (2) refuses to accept "non-black": a frozen last frame is non-black too, so the
 * evidence is that the screen CHANGES after recovery. Whether the GUEST then walks itself out
 * of DEVICENOTRESET is reported but not gated — that depends on where in the title's own
 * lifecycle the loss landed, and the deterministic proof that the sequence is walkable at all
 * is `tools/tests/gpu-device-loss.test.ts`.
 *
 *   WGB=G:/WGB/running/morrowind.wgb bun tools/harness.ts run tools/harness/regression/gpu-device-loss-recovery.harness.ts
 *
 * Any d3d8/d3d9/ddraw title works. Morrowind (d3d8) is the default because its real
 * `deviceLost` started this; TR2 exercises the ddraw surface path and GTA III the d3d9 one.
 *
 * Confirmed able to fail: `if (true) return D3D_OK;` at the top of the d3d8/d3d9
 * TestCooperativeLevel handler trips check (3) — the check calls the REGISTERED THUNK, so it
 * sees the handler's real answer and not the contract module's opinion of it.
 */

import { harness } from "../../harness";

const WGB = process.env.WGB ?? "G:/WGB/running/morrowind.wgb";
/** Presents to wait for before deciding the title is up, and again after the loss. */
const WARMUP_FRAMES = 240;
const RECOVERY_FRAMES = 90;

const fail = (msg: string): never => { throw new Error(msg); };

const screen = async (): Promise<{ presentSerial: number; presenter: string | null }> => {
    const r: any = await harness().state(["screen"]).run();
    return r.steps[0].result.screen;
};

/** The composited screen. Two captures that differ is proof pixels are moving, and
 *  `presentsSinceCapture` says whether the mirror the capture reads is being refreshed at all
 *  — on a device that never came back it grows without bound while the image looks fine. */
const shot = async (save: string): Promise<{ b64: string; age: number }> => {
    const r: any = await harness().shot({ save }).run();
    const res = r.steps[0].result;
    if (typeof res?.base64 !== "string" || res.base64.length === 0) {
        fail(`shot() returned no image (${save}) — the screen could not be read at all`);
    }
    return { b64: res.base64 as string, age: res.presentsSinceCapture ?? -1 };
};

// ── boot until the guest is actually presenting ─────────────────────────────────────
const boot: any = await harness().openWgb(WGB).tickFrames(WARMUP_FRAMES).run();
if (!boot.ok) fail(`boot failed: ${boot.error}`);

const screenBefore = await screen();
if (screenBefore.presentSerial <= 0) fail("the title never presented a frame — nothing to lose");
const before = await shot("before-loss");

// ── lose the device ─────────────────────────────────────────────────────────────────
const lost: any = await harness().gpuLoseDevice().run();
if (!lost.ok) fail(`gpuLoseDevice failed: ${lost.error}`);
const r = lost.steps[0].result;

// (1) observed
if (!r.recovered) fail(`no replacement device was obtained: ${JSON.stringify(r.after)}`);
if (r.after.generation !== r.before.generation + 1) {
    fail(`device generation did not advance: ${r.before.generation} -> ${r.after.generation}`);
}
if (r.after.status !== "ok") fail(`backend did not return to "ok": ${r.after.status}`);
if (r.after.observerErrors.length > 0) {
    fail(`observers threw while invalidating: ${JSON.stringify(r.after.observerErrors)}`);
}
if (!r.during) fail("the invalidation fan-out never ran — nothing was told the device was lost");

// (3) the guest was told, at the instant it was true.
// `hr` is what the REGISTERED THUNK returned, not what the contract module thinks — a handler
// wired back to D3D_OK is invisible to the latter.
type Coop = { hr: string; contract: string };
const coopDuring: Record<string, Coop> = r.during.testCooperativeLevel ?? {};
const coopKeys = Object.keys(coopDuring);
const lostSurfacesDuring: number = r.during.ddrawLostSurfaces ?? 0;
let toldVia: string;
if (coopKeys.length > 0) {
    const dishonest = coopKeys.filter((k) => coopDuring[k].hr === "D3D_OK");
    if (dishonest.length > 0) {
        fail(`TestCooperativeLevel answered D3D_OK to the guest for ${dishonest.join(", ")} while ` +
            `the device was lost (contract said "${coopDuring[dishonest[0]!]!.contract}" — the handler is not using it)`);
    }
    const unavailable = coopKeys.filter((k) => coopDuring[k].hr.startsWith("unavailable"));
    if (unavailable.length > 0) {
        fail(`could not ask the guest-facing thunk for ${unavailable.join(", ")}: ${coopDuring[unavailable[0]!]!.hr}`);
    }
    toldVia = `TestCooperativeLevel=${coopKeys.map((k) => `${k}:${coopDuring[k].hr}`).join(",")}`;
} else if (lostSurfacesDuring > 0) {
    toldVia = `IDirectDrawSurface::IsLost (${lostSurfacesDuring} surface(s) answered DDERR_SURFACELOST)`;
} else {
    // A title with no d3d8/d3d9 device object and no GPU-only surface has nothing that CAN be
    // reported lost. Say so rather than pass quietly on a check that never ran.
    toldVia = "NOT EXERCISED (no d3d8/d3d9 device and no GPU-only surface on this title)";
}
for (const [dev, level] of Object.entries<Coop>(r.after.testCooperativeLevel ?? {})) {
    if (level.hr === "D3DERR_DEVICELOST") fail(`device ${dev} still reports D3DERR_DEVICELOST after recovery`);
}

// (2) the picture comes back, and keeps moving.
//
// This POLLS rather than sampling once. A title inside its intro movie presents a run of
// identical black frames and only re-enters its render loop (and its device-reset path) some
// seconds later — sampling twice 30 frames apart there measures the movie, not the recovery.
// The deadline is what makes a negative mean something: "did not recover within N seconds".
const DEADLINE_MS = 90_000;
const deadline = Date.now() + DEADLINE_MS;
let screenAfter = screenBefore;
let after = before;
let changed = false;
// Whether the GUEST walked itself out of DEVICENOTRESET. Reported, never gated: whether it
// happens inside any deadline depends on where in the title's own lifecycle the loss landed
// (GTA III sits in its intro for minutes before its render loop resets the device, and resets
// correctly when it gets there). Gating on it would make this scenario flake on the guest's
// pacing. The DETERMINISTIC proof that the sequence is walkable is the unit test.
let coopRecovered = coopKeys.length === 0;   // nothing to reset ⇒ nothing to wait for
let lastCoop: Record<string, Coop> = {};
while (Date.now() < deadline && !(changed && coopRecovered)) {
    const tick: any = await harness().tickFrames(RECOVERY_FRAMES).run();
    if (!tick.ok) fail(`the guest stopped presenting after the loss: ${tick.error}`);
    screenAfter = await screen();
    after = await shot("after-loss");
    changed = after.b64 !== before.b64;
    const st: any = await harness().gpuDeviceState().run();
    lastCoop = st.steps[0].result.testCooperativeLevel ?? {};
    coopRecovered = Object.values(lastCoop).every((v) => v.hr === "D3D_OK");
}
if (screenAfter.presentSerial <= screenBefore.presentSerial) {
    fail(`no frame reached the canvas after recovery (presentSerial stuck at ${screenAfter.presentSerial})`);
}
if (!changed) {
    fail("the screen never changed after recovery — frames are presented but nothing is drawing");
}
// The mirror is a real GPU copy taken on every present; it can only be current if the
// recreated device is executing our command buffers.
if (after.age < 0 || after.age > 8) {
    fail(`the screen mirror is ${after.age} presents stale — the recreated device is not copying frames`);
}
// "notreset" that never clears is the guest's own pacing and is reported below. "lost" that
// never clears is OURS — it says the backend never produced a device — and that is a failure.
for (const [dev, level] of Object.entries(lastCoop)) {
    if (level.hr === "D3DERR_DEVICELOST") fail(`device ${dev} still answers D3DERR_DEVICELOST ${DEADLINE_MS / 1000}s after the loss`);
}

// A GPU error census that grew because of the loss itself is expected (the deviceLost entry);
// anything the RECREATED device refuses is not.
const rep: any = await harness().call("report").run();
const gpu = rep.steps[0].result.gpuErrors;
const uncaptured = gpu.byKind.uncaptured ?? 0;
if (uncaptured > 0) {
    fail(`the recreated device refused work (${uncaptured} uncaptured error(s)): ` +
        JSON.stringify(gpu.distinct.filter((d: any) => d.kind === "uncaptured")));
}

console.log(JSON.stringify({
    ok: true,
    wgb: WGB,
    presenter: screenAfter.presenter,
    generation: `${r.before.generation} -> ${r.after.generation}`,
    recoveryMs: r.after.lastRecoveryMs,
    guestWasTold: toldVia,
    surfaces: r.after.lastSurfaceLoss,
    presentSerial: `${screenBefore.presentSerial} -> ${screenAfter.presentSerial}`,
    // Reported, not gated — see the poll loop above.
    guestReset: coopKeys.length === 0
        ? "n/a (no d3d8/d3d9 device)"
        : coopRecovered
            ? `the guest completed its own Reset(): ${JSON.stringify(lastCoop)}`
            : `NOT OBSERVED within ${DEADLINE_MS / 1000}s: ${JSON.stringify(lastCoop)}`,
    observers: r.after.observers,
}, null, 2));
