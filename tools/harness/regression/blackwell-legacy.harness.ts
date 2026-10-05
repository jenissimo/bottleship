/**
 * Blackwell Legacy (AGS 3.6 / SDL2 / GOG) bring-up regression.
 * Guards: SleepConditionVariableSRW post-return ESP + CV wake/requeue paths,
 * agsgalaxy.dll clean-fail → AGS builtin stub, per-draw FFP state (transforms /
 * stage-0 combiner / TFACTOR), D3DPT_TRIANGLESTRIP conversion, RT-texture pass.
 *
 * Prereqs: `bun tools/harness.ts up`. Bundle path from WGB env var, default
 * matches the drop-folder copy /apps/external-wgb/blackwell-legacy.wgb.
 * Expected end state: the title screen renders (title art + menu), presenter=d3d9,
 * presentSerial climbing, all 5 threads alive.
 */
import { harness } from "../../harness";

const result = await harness()
    .openWgb(process.env.WGB ?? "/apps/external-wgb/blackwell-legacy.wgb")
    .tickFrames(240, { timeoutMs: 120_000 })
    .state(["threads", "screen"])
    .shot({ save: "blackwell-title.png" })
    .run();

const r: any = result;
const screen = r.named?.state?.screen;
const threads = r.named?.state?.threads?.threads ?? [];
const terminated = threads.filter((t: any) => t.stateName === "TERMINATED").length;
console.log(`presenter=${screen?.presenter} presentSerial=${screen?.presentSerial} threads=${threads.length} terminated=${terminated}`);
if (screen?.presenter !== "d3d9" || (screen?.presentSerial ?? 0) < 100 || terminated > 0) {
    console.log("REGRESSION: expected d3d9 presenter, >100 presents, 0 terminated threads");
    process.exitCode = 1;
}
