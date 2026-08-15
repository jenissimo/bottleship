/**
 * A FULLSCREEN D3D9 device puts its window into the device's mode.
 *
 * Real D3D resizes the focus window's client area to the back buffer, and engines read that
 * back rather than trusting the number they asked for. RenderWare is the sharp case: its
 * camera frame-buffer raster refuses a camera larger than GetClientRect(hwnd), so a device
 * whose window never learned the new mode makes RwCameraCreate return NULL — and GTA III
 * then fires its next rsCAMERASIZE at that NULL camera and dies with an access violation
 * a few hundred ms later, nowhere near the call that actually failed.
 *
 * D3D8 and DirectDraw have done this for a while; the D3D9 path (which is where every
 * d3d8-to-d3d9 wrapper lands) did not, so the mismatch only appeared once a title CHANGED
 * resolution — the boot device happened to fit inside the window it was given.
 *
 *   WGB=G:/WGB/running/gta3-ru.wgb bun tools/harness.ts run tools/harness/regression/d3d9-fullscreen-window.harness.ts
 *
 * Asserts the invariant, not the crash: the tracked window rect, the published display mode
 * and the device's back buffer are one number. Confirmed able to fail — with the
 * CreateDevice/Reset resize removed, GTA III boots with a 808x627 window against an 800x600
 * device and this reports the mismatch.
 */

import { harness } from "../../harness";

const WGB = process.env.WGB ?? "G:/WGB/running/gta3-ru.wgb";
/** Presents to wait for: the title has to get past its logos and create the real device. */
const BOOT_FRAMES = Number(process.env.FRAMES ?? 500);

const PROBE = `
    const ss = await import("/src/worker/modules/user32/shared-state.ts");
    const sys = (await import("/src/worker/core/system.ts")).System.getInstance();
    const d3d9 = await import("/src/worker/modules/d3d9/shared-state.ts");
    const devices = [...d3d9.devices.entries()].map(([ptr, dev]) => ({
        ptr: "0x" + (ptr >>> 0).toString(16),
        viewport: dev.getViewport ? dev.getViewport() : null,
    }));
    const windows = [...ss.windows.values()]
        .filter((w) => w.visible && !(w.style & 0x40000000) /* WS_CHILD */)
        .map((w) => ({ title: w.title, w: w.width, h: w.height }));
    return { devices, windows, mode: sys.emulatedDisplayMode };
`;

const boot: any = await harness()
    .openWgb(WGB)
    .watchFrames(true)
    .tickFrames(BOOT_FRAMES, { timeoutMs: 300000 })
    .call("evalWorker", [PROBE])
    .run();

const probe = boot.steps.find((s: any) => s.cmd === "evalWorker")?.result;
if (!probe) throw new Error("probe did not run — no worker state to judge");
if (!probe.devices.length) {
    throw new Error(`no D3D9 device after ${BOOT_FRAMES} presents — this fixture needs a d3d9 title`);
}
if (!probe.mode) throw new Error("no display mode was ever published — the device is not fullscreen");

const { width, height } = probe.mode;
// The device's own viewport follows the back buffer, so it is the back buffer's witness.
const vp = probe.devices[0].viewport;
if (vp && (vp.width !== width || vp.height !== height)) {
    throw new Error(`device viewport ${vp.width}x${vp.height} disagrees with the published mode `
        + `${width}x${height} — the mode-set and the device are not the same number`);
}

const top = probe.windows[0];
if (!top) throw new Error("no visible top-level window — nothing was put into the mode");
if (top.w !== width || top.h !== height) {
    throw new Error(`the fullscreen window "${top.title}" is ${top.w}x${top.h} while the device mode is `
        + `${width}x${height}. GetClientRect answers the first number, so an engine that sizes its `
        + "render target from the window (RenderWare's camera raster) builds it for the wrong mode "
        + "or fails outright — CreateDevice/Reset must resize the device window (see "
        + "runtime/windowing/fullscreen-window.ts).");
}

console.log(`OK — fullscreen window, published mode and device viewport all agree at ${width}x${height} `
    + `("${top.title}")`);
