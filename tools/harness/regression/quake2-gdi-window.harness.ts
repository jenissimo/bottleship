/**
 * Regression: a window DC the guest NEVER releases must still reach the screen.
 *
 * Quake II's software renderer is the canonical shape — one GetDC for the process
 * lifetime, a BitBlt from its DIBSection every frame, ReleaseDC only at shutdown.
 * Publishing window DCs on ReleaseDC alone left that game rendering into a DC nobody
 * composited: a live frame loop behind a bare desktop.
 *
 * Drives it into the windowed DIB path deterministically via baseq2/autoexec.cfg
 * (the bundle ships no config.cfg, so cvar defaults otherwise pick DirectDraw).
 *
 *   WGB=G:/WGB/running/quake2.wgb bun tools/harness.ts run tools/harness/regression/quake2-gdi-window.harness.ts
 */
import { harness } from "../../harness";

const WGB = process.env.WGB ?? "/apps/external-wgb/quake2.wgb";

const autoexec = [
  'set vid_ref "soft"',
  'set vid_fullscreen "0"',
  'set sw_mode "0"',
  "",
].join("\n");

await harness()
  .call("fsWrite", "C:\\baseq2\\autoexec.cfg", autoexec)
  .call("fsFlush")
  .openWgb(WGB)
  .sleep(25000)
  .run();

const read = async () => {
  const r = await harness().state(["windows", "screen"]).run();
  return (r as any).named.state as {
    windows: { title: string; customPaint: boolean }[];
    screen: { presenter: string; presentSerial: number };
  };
};

const first = await read();
await harness().sleep(3000).run();
const second = await read();

// The overlay is keyed by gameId, not by tab — leaving the fixture behind would
// silently override the renderer for every later session, including the user's.
await harness().call("fsDelete", "C:\\baseq2\\autoexec.cfg").call("fsFlush").run();

const win = second.windows.find((w) => /quake/i.test(w.title));
const advanced = second.screen.presentSerial - first.screen.presentSerial;

console.log(JSON.stringify({ presenter: second.screen.presenter, advanced, customPaint: win?.customPaint }, null, 1));

// customPaint is set only when a guest window DC actually published to the overlay;
// presentSerial advancing proves the composite reaches the canvas, not just the DC.
if (!win) throw new Error("Quake 2 window not found");
if (!win.customPaint) throw new Error("guest window DC never published (held-DC flush regressed)");
if (advanced < 10) throw new Error(`screen is not presenting: presentSerial advanced by ${advanced}`);
console.log("OK");
