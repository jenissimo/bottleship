/** Assert D3D8 menu rendering for direct-entry and launcher-based demo bundles. */
import { harness, closeHarnessConnection } from "../../harness";

const WGB = process.env.WGB ?? "/apps/external-wgb/warcraft3-demo.wgb";
const BOOT_MS = Number(process.env.BOOT_MS ?? 25000);
let navigated = false;
const boot = await harness().openWgb(WGB).sleep(BOOT_MS).run().catch((error: unknown) => {
    if (/navigated or closed/i.test(String(error))) { navigated = true; return null; }
    throw error;
});
if (boot && !boot.ok) throw new Error(`Boot failed: ${boot.error?.message}`);
if (navigated) {
    closeHarnessConnection();
    await Bun.sleep(5000);
}
const result = await harness().sleep(navigated ? BOOT_MS : 0)
    .state(["screen"])
    .call("screenRegionHash", { x: 200, y: 150, w: 400, h: 300 })
    .call("stubs").run();
if (!result.ok) throw new Error(`Menu inspection failed: ${result.error?.message}`);
const screen = (result.named.state as { screen: { presenter: string; presentSerial: number } }).screen;
const pixels = result.named.screenRegionHash as { mean: number };
const stubs = result.named.stubs as Array<{ api: string }>;
if (screen.presenter !== "d3d8" || screen.presentSerial < 1 || pixels.mean < 8) {
    throw new Error(`No rendered D3D8 menu: ${JSON.stringify({ screen, pixels })}`);
}
if (stubs.length) throw new Error(`Unimplemented APIs during boot: ${stubs.map(s => s.api).join(", ")}`);
console.log(`OK — D3D8 menu rendered (mean ${pixels.mean}), no unimplemented APIs`);
