import { buildD3D9CapabilityProfile, validateD3D9CapabilityProfile } from "./caps-profile";

const output = process.argv[2] ?? "tools/fixtures/d3d9-capability-profile.json";
const profile = buildD3D9CapabilityProfile();
const errors = validateD3D9CapabilityProfile(profile);
if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
}
await Bun.write(output, `${JSON.stringify(profile, null, 2)}\n`);
console.log(`${output}: ${profile.counts.advertised} advertised fields, ` +
    `${profile.counts.advertisedWithoutProof} reference-only advertised gaps`);

