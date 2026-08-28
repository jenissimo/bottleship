import {
    buildD3D9CapabilityProfile,
    validateCheckedInRealCaps9,
    validateD3D9CapabilityProfile,
} from "./caps-profile";

// Two independent subjects: the checked-in reference hardware blob (layout + truth
// table) and the caps we actually answer with. The blob alone was validated here for a
// while, under a success line that read as a statement about our own D3DCAPS9.
const reference = validateCheckedInRealCaps9();
if (reference.errors.length > 0) {
    console.error(reference.errors.join("\n"));
    process.exit(1);
}

const profile = buildD3D9CapabilityProfile();
const profileErrors = validateD3D9CapabilityProfile(profile);
if (profileErrors.length > 0) {
    console.error(profileErrors.join("\n"));
    process.exit(1);
}

const referenceAdvertised = reference.fields.filter(field => field.advertised).length;
console.log(`D3DCAPS9 REAL_CAPS9_HEX OK — ${reference.fields.length} fields, ` +
    `${referenceAdvertised} advertised, field truth table matched`);
console.log(`writeDeviceCaps9 OK — ${profile.counts.fields} fields, ` +
    `${profile.counts.advertised} advertised, ${profile.counts.refused} refused (all zero), ` +
    `${profile.counts.advertisedWithoutProof} advertised without proof (ratchet)`);
