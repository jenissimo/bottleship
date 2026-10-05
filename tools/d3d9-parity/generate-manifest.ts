import { buildD3D9Inventory } from "./inventory";
import { validateD3D9ProbeManifest } from "./probe-oracle";

const output = process.argv[2] ?? "tools/fixtures/d3d9-bottleship-inventory.json";
const inventory = buildD3D9Inventory();
const parityErrors = validateD3D9ProbeManifest(inventory.parity);
if (parityErrors.length > 0) {
    console.error(parityErrors.join("\n"));
    process.exit(1);
}
await Bun.write(output, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`${output}: ${inventory.counts.methods} methods, ` +
    `${inventory.counts.dispatcherFallback} dispatcher fallbacks, ` +
    `${inventory.counts.refused} explicit refusals, ` +
    `${inventory.parity.counts.total} executable parity probes ` +
    `(${inventory.parity.counts.awaitingCapture} awaiting native/DXVK capture)`);
// Building the runtime export table installs process-owned observers/timers.
// This command is a one-shot artifact generator, so terminate explicitly after
// the file has been flushed instead of leaving CI waiting on the runtime.
process.exit(inventory.counts.dispatcherFallback === 0 ? 0 : 1);
