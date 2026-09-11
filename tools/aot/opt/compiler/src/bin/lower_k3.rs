//! Emit the conservative Arm B unit for k3 and describe it as JSON.
//!
//! The bytes go to stdout as hex and the description as one JSON object, so the JS side can hand
//! both to the EXISTING unit verifier (`tools/aot/lib/verify.mjs`) without this crate depending on
//! it. That verifier already checks the parts of the external ABI it really checks; reusing it is
//! how a new emitter finds out it is wrong about the contract rather than at publication time.

use bottleship_opt_compiler::{lower_region, lift_k3, K3_BYTES};

const ENTRY: u32 = 0x0010_3000;

fn main() {
    let region = match lift_k3(ENTRY, &K3_BYTES) {
        Ok(r) => r,
        Err(e) => {
            println!("{{\"status\":\"lift_failed\",\"why\":\"{e}\"}}");
            std::process::exit(3);
        }
    };
    // CPL0: the oracle image runs in ring 0, and the TLB masks differ by privilege.
    let lowered = match lower_region(&region, false) {
        Ok(l) => l,
        Err(e) => {
            println!("{{\"status\":\"lower_failed\",\"why\":\"{e}\"}}");
            std::process::exit(4);
        }
    };

    let hex: String = lowered.unit.bytes.iter().map(|b| format!("{b:02x}")).collect();
    let imports: Vec<String> = lowered.unit.imports.iter().map(|n| format!("\"{n}\"")).collect();
    let relocs: Vec<String> = lowered
        .unit
        .relocs
        .iter()
        .map(|r| {
            format!(
                "{{\"kind\":\"{}\",\"fileOffset\":{},\"width\":{}}}",
                r.kind,
                lowered.unit.body_start + r.at,
                r.width
            )
        })
        .collect();
    let deltas: Vec<String> = lowered.exit_deltas.iter().map(|d| d.to_string()).collect();
    println!(
        "{{\"status\":\"ok\",\"case\":\"k3\",\"entry_eip\":{ENTRY},\
         \"bytes\":{},\"body_start\":{},\"local_count\":{},\
         \"imports\":[{}],\"relocs\":[{}],\"exit_deltas\":[{}],\"hex\":\"{hex}\"}}",
        lowered.unit.bytes.len(),
        lowered.unit.body_start,
        lowered.unit.local_count,
        imports.join(","),
        relocs.join(","),
        deltas.join(","),
    );
}
