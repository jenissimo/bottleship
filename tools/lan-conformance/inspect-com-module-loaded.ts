import { createHash } from "node:crypto";
import { join } from "node:path";
const names = ["com-module-loaded", "com-module-loaded-classic", "com-module-loaded-lobby", "com-module-loaded-bad-iid"];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const results = [];
for (const fixture of names) {
    const directory = join("logs", "lan-conformance", fixture);
    const build = await Bun.file(join(directory, "build.json")).json();
    const bytes = new Uint8Array(await Bun.file(build.reference).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x42534c4e || view.getUint32(4, true) * 4 !== bytes.length ||
        view.getUint32(8, true) !== build.nonce || sha(bytes) !== build.referenceSha256) throw Error("Invalid reference: " + fixture);
    const observations = Array.from({ length: bytes.length / 4 - 3 }, (_, i) => view.getUint32((i + 3) * 4, true));
    if (observations.length !== 49) throw Error("Unexpected record schema: " + fixture);
    const snapshot = (offset: number) => ({
        phase: observations[offset],
        dpnet: { ansiLoaded: observations[offset + 1] === 1, wideLoaded: observations[offset + 2] === 1, sameHandle: observations[offset + 3] === 1 },
        dplayx: { ansiLoaded: observations[offset + 4] === 1, wideLoaded: observations[offset + 5] === 1, sameHandle: observations[offset + 6] === 1 },
    });
    const snapshots = [1, 9, 18, 27, 35, 42].map(snapshot);
    for (let i = 0; i < snapshots.length; i++) if (snapshots[i]!.phase !== i) throw Error("Phase mismatch: " + fixture);
    const source = new Uint8Array(await Bun.file(join("tools", "lan-conformance", fixture + ".c")).arrayBuffer());
    results.push({
        fixture, nonce: build.nonce, build: join(directory, "build.json"), sourceSha256: sha(source),
        executableSha256: build.executableSha256, referenceSha256: build.referenceSha256,
        classKind: observations[0], initializeHresult: observations[8],
        unknownClassHresult: "0x" + observations[16]!.toString(16), unknownClassOutputNull: observations[17] === 1,
        activationHresult: "0x" + observations[25]!.toString(16), activationObjectReturned: observations[26] === 1,
        objectReleased: observations[34] === 1, snapshots, observations,
    });
}
const additionalReferences = [];
for (const fixture of ["com-module-retention", "com-module-retention-library", "com-module-retention-import", "com-module-retention-apartments", "com-module-retention-ro", "com-module-retention-ro-reverse"]) {
    const directory = join("logs", "lan-conformance", fixture);
    const build = await Bun.file(join(directory, "build.json")).json();
    const bytes = new Uint8Array(await Bun.file(build.reference).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x42534c4e || view.getUint32(4, true) * 4 !== bytes.length ||
        view.getUint32(8, true) !== build.nonce || sha(bytes) !== build.referenceSha256) throw Error("Invalid reference: " + fixture);
    additionalReferences.push({ fixture, build: join(directory, "build.json"), nonce: build.nonce,
        executableSha256: build.executableSha256, referenceSha256: build.referenceSha256,
        libraries: build.libraries,
        observations: Array.from({length: bytes.length / 4 - 3}, (_,i) => view.getUint32((i + 3) * 4, true)) });
}
const report = {
    nativeOnly: true,
    schema: "classKind; phase0[7]; CoInitialize; phase1[7]; unknownHRESULT,outNull; phase2[7]; targetHRESULT,objectReturned; phase3[7]; objectReleased; phase4[7]; phase5[7]",
    phases: ["before COM", "after CoInitialize", "after unregistered class", "after target CoCreateInstance", "after object Release", "after CoUninitialize"],
    commonSourceSha256: sha(new Uint8Array(await Bun.file("tools/lan-conformance/com-module-loaded.c").arrayBuffer())),
    cases: results,
    additionalReferences,
};
const output = join("logs", "lan-conformance", "com-module-loaded", "observed-contract.json");
await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, observations: results.length * 49 + additionalReferences.reduce((total, entry) => total + entry.observations.length, 0), cases: results.map(({fixture, nonce, activationHresult, snapshots}) => ({fixture, nonce, activationHresult, snapshots})) }, null, 2));
