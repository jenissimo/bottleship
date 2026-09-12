/**
 * Kernel-ledger census over a game's LOAD, which is where the string and bulk leaves are
 * expected to concentrate: resource lookup by name, archive parsing, decompression.
 *
 * Reads, not measures. The point is to learn which of the guarded kernels a real title
 * touches at all, before designing an A/B that might have nothing to measure. WGB and
 * LABEL come from the environment so this is not tied to one bundle.
 */
import { harness } from "../harness";

const bundle = process.env.WGB;
if (!bundle) throw new Error("WGB is required — an absolute .wgb path or a drop-folder URL");
const seconds = Number(process.env.SECONDS ?? 90);

const out = await harness()
    .streamLogs(["SYSTEM"])
    // No mark: openWgb reloads the page, which re-instantiates the engine and zeroes every
    // ledger, so the counts below already start at the load. A mark is for a window INSIDE
    // a session that is already running — taken before a reload it is simply discarded.
    .openWgb(bundle)
    .sleep(seconds * 1000)
    .call("kernelLedgers")
    .state(["threads", "modules"])
    .run();

console.log(JSON.stringify(out, null, 2));
