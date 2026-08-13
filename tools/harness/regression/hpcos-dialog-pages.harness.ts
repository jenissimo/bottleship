/** Ground-truth regression for Win32 child-dialog page switching in HP CoS. */
import { harness } from "../../harness";

const WGB = process.env.WGB ?? "g:/WGB/running/harry-potter-cos.wgb";

const result = await harness()
    .openWgb(WGB)
    .waitForControl("New Game", { timeoutMs: 300_000 })
    .sleep(750)
    .shot({ save: "logs/cos-ui-main.png" })
    .click("Load Game")
    .waitForControl("Back", { timeoutMs: 60_000 })
    // The load page populates six slots through synchronous subclass callbacks and
    // async file probes; existence of Back does not yet mean WM_INITDIALOG returned.
    .sleep(2500)
    .shot({ save: "logs/cos-ui-load.png" })
    .click("Back")
    .waitForControl("New Game", { timeoutMs: 60_000 })
    .sleep(1500)
    .shot({ save: "logs/cos-ui-back.png" })
    .state(["windows", "dinput"])
    .run();

if (!result.ok) process.exitCode = 1;
