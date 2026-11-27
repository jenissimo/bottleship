/**
 * Blackwell Legacy (AGS 3.6 / SDL2 / GOG) bring-up regression.
 * Guards: SleepConditionVariableSRW post-return ESP + CV wake/requeue paths,
 * agsgalaxy.dll clean-fail → AGS builtin stub, per-draw FFP state (transforms /
 * stage-0 combiner / TFACTOR), D3DPT_TRIANGLESTRIP conversion, RT-texture pass.
 *
 * Prereqs: `bun tools/harness.ts up`. Bundle path from WGB env var, default
 * matches the drop-folder copy /apps/external-wgb/blackwell-legacy.wgb.
 * Expected end state: the title screen renders (title art + menu), presenter=d3d9,
 * presentSerial climbing, and no terminated threads.
 */
import { harness } from "../../harness";
import { readBlackwellTitle } from "./blackwell-title";

const result = await harness()
    .openWgb(process.env.WGB ?? "/apps/external-wgb/blackwell-legacy.wgb")
    .tickFrames(840, { timeoutMs: 170_000 })
    .state(["threads", "screen"])
    .evalPage(readBlackwellTitle, 6000)
    .shot({ save: "blackwell-title.png" })
    .run();

const r: any = result;
const screen = r.named?.state?.screen;
const threads = r.named?.state?.threads?.threads ?? [];
const terminated = threads.filter((t: any) => t.stateName === "TERMINATED").length;
const title = r.named?.evalPage;
console.log({ presenter: screen?.presenter, presentSerial: screen?.presentSerial,
    threads: threads.length, terminated, title });
if (!result.ok || screen?.presenter !== "d3d9" || (screen?.presentSerial ?? 0) < 240 ||
    threads.length === 0 || terminated > 0 || title?.matches !== true) {
    console.error("Expected the Blackwell menu, 240 or more D3D9 presents, and live threads");
    process.exitCode = 1;
}
