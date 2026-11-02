import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { harness, closeHarnessConnection } from "../harness";

const buildPath = resolve(process.env.BS_ORACLE_BUILD ?? "logs/lan-conformance/build.json");
const build = await Bun.file(buildPath).json() as {
    fixture?: string; bundle: string; reference: string; executableSha256?: string; referenceSha256?: string;
};
const reference = new Uint8Array(await Bun.file(build.reference).arrayBuffer());
const referenceView = new DataView(reference.buffer);
if (reference.length < 12 || referenceView.getUint32(0, true) !== 0x42534c4e
    || referenceView.getUint32(4, true) * 4 !== reference.length) throw new Error("Invalid native oracle record.");
const nonce = referenceView.getUint32(8, true);
const referenceSha256 = createHash("sha256").update(reference).digest("hex");
if (build.referenceSha256 && build.referenceSha256 !== referenceSha256) throw new Error("Native record changed after the bundle was built.");
try {
    let boot = harness();
    if (process.env.BS_LAN_SERVER) {
        const config = { serverUrl: process.env.BS_LAN_SERVER, room: process.env.BS_LAN_ROOM ?? "conformance" };
        const connect = `new Promise((resolve, reject) => {
            const worker = window.worker;
            const timer = setTimeout(() => { worker.removeEventListener("message", done); reject(new Error("LAN readiness timeout")); }, 15000);
            const done = event => {
                if (event.data?.type !== "network_state" || !["connected", "error"].includes(event.data.status.state)) return;
                clearTimeout(timer); worker.removeEventListener("message", done);
                if (event.data.status.state === "connected") resolve(true); else reject(new Error(event.data.status.reason));
            };
            worker.addEventListener("message", done);
            worker.postMessage({ type: "set_network", network: ${JSON.stringify(config)} });
        })`;
        boot = boot.reload().evalPage(connect, 20000).openWgb(build.bundle, { reload: false });
    } else boot = boot.openWgb(build.bundle);
    const loaded = await boot.run();
    if (!loaded.ok) throw new Error("Guest load failed: " + JSON.stringify(loaded));
    const deadline = Date.now() + 30_000;
    let actual: Uint8Array | null = null;
    while (Date.now() < deadline) {
        const result = await harness().fsRead("C:\\lan-oracle.bin").run();
        const record = result.named.fsRead as { content?: string } | undefined;
        if (result.ok && record?.content) {
            const bytes = Uint8Array.from(atob(record.content), c => c.charCodeAt(0));
            const view = new DataView(bytes.buffer);
            if (bytes.length >= 12 && view.getUint32(0, true) === 0x42534c4e
                && view.getUint32(4, true) * 4 === bytes.length && view.getUint32(8, true) === nonce) {
                actual = bytes;
                break;
            }
        }
        await Bun.sleep(250);
    }
    if (!actual) {
        const report = await harness().report().run();
        throw new Error("Guest did not finish the current oracle build: " + JSON.stringify(report));
    }
    const differences: Array<{ observation: number; native: number | null; guest: number | null }> = [];
    const guestView = new DataView(actual.buffer);
    for (let index = 3; index < Math.max(actual.length, reference.length) / 4; index++) {
        const native = index * 4 < reference.length ? referenceView.getInt32(index * 4, true) : null;
        const guest = index * 4 < actual.length ? guestView.getInt32(index * 4, true) : null;
        if (native !== guest) differences.push({ observation: index - 3, native, guest });
    }
    const guestRecord = join(dirname(buildPath), `guest-${nonce}.bin`);
    const comparison = join(dirname(buildPath), `comparison-${nonce}.json`);
    await Bun.write(guestRecord, actual);
    await Bun.write(comparison, JSON.stringify({
        fixture: build.fixture, nonce, comparedAt: new Date().toISOString(),
        observations: reference.length / 4 - 3, executableSha256: build.executableSha256,
        referenceSha256, guestSha256: createHash("sha256").update(actual).digest("hex"),
        guestRecord, differences,
    }, null, 2) + "\n");
    console.log(JSON.stringify({ observations: reference.length / 4 - 3, differences, comparison }, null, 2));
    if (differences.length) throw new Error("Network API observations differ from native Windows.");
} finally {
    closeHarnessConnection();
}
