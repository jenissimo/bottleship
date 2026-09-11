//! Stable, dependency-free wire adapter for one k3 wrapper call.

use bottleship_opt_compiler::{
    execute, lift_k3, ExecuteExit, Flags, Gpr, Machine, Memory, MemoryFault, K3_BYTES,
};

const WIRE_VERSION: u32 = 1;
const ENTRY: u32 = 0x0010_3000;
// Kept in step with `aot-oracle/corpus/layout.mjs` DST3 by `k3-differential.mjs`, which refuses
// to compare when the two disagree — the reason this constant may live here at all.
const DST: u32 = 0x0011_2800;
const SOURCE: u32 = 0x0010_d000;
const EDI: u32 = SOURCE.wrapping_sub(DST);
const K3_SHA256: &str = "f92e8ad00d112bc46ea8bab9fd401410e4cefc3b9ad8ff4a21be9d67d44ae345";
const DEFAULT_COUNT: usize = 64;

fn flags_json(flags: Flags) -> String {
    format!(
        "{{\"cf\":{},\"pf\":{},\"af\":{},\"zf\":{},\"sf\":{},\"of\":{}}}",
        flags.cf, flags.pf, flags.af, flags.zf, flags.sf, flags.of
    )
}

fn gprs_json(machine: &Machine) -> String {
    format!(
        "{{\"eax\":{},\"ecx\":{},\"edx\":{},\"ebx\":{},\"esp\":{},\"ebp\":{},\"esi\":{},\"edi\":{}}}",
        machine.get(Gpr::Eax), machine.get(Gpr::Ecx), machine.get(Gpr::Edx), machine.get(Gpr::Ebx),
        machine.get(Gpr::Esp), machine.get(Gpr::Ebp), machine.get(Gpr::Esi), machine.get(Gpr::Edi),
    )
}

fn source_word(index: usize) -> u32 {
    let mut state = 0x00c0_ffeeu32;
    for _ in 0..=index {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    }
    if state % 3 == 0 {
        0
    } else {
        state
    }
}

/// The destination as the ORACLE reads it — host view, not guest view. A fault scenario revokes
/// the page, and reading it through the guest accessor would then fail to report the very bytes
/// the scenario exists to compare.
fn dst_hex(memory: &Memory, count: usize) -> String {
    memory
        .peek(DST, count * 4)
        .expect("destination in bounds")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn main() {
    let count = std::env::var("AOT_ORACLE_COUNT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_COUNT);
    let region = lift_k3(ENTRY, &K3_BYTES).expect("embedded retail k3 must lift");
    let mut memory = Memory::new(0x20_0000);
    let mut machine = Machine::new(ENTRY);
    // Canonical image-driver state immediately before the selected k3 wrapper.
    machine.set(Gpr::Ebx, 0x7c00);
    machine.set(Gpr::Esp, 0x0010_c000);
    machine.set(Gpr::Ecx, DST);
    machine.set(Gpr::Edi, EDI);
    machine.set(Gpr::Eax, count as u32);
    // Mirrors `layout.mjs`: the fill covers the COUNT in use, never a fixed 0x100 words. A
    // shorter fill leaves the tail reading zeros here and real data in the image, so the two arms
    // would compute different answers from "the same" input at any count above 256.
    let source_words = std::cmp::max(0x100, count);
    for i in 0..source_words {
        memory
            .write_u32(SOURCE + (i * 4) as u32, source_word(i))
            .expect("source in bounds");
    }
    for i in 0..count {
        memory
            .write_u32(DST + (i * 4) as u32, 0)
            .expect("destination in bounds");
    }

    // `BS_K3_REVOKE_PAGE` revokes one page before the run, mirroring what an MMU scenario does to
    // the guest's page tables. It is what lets the fault PATH be compared across arms instead of
    // only the clean one: a candidate can reproduce every clean result and still restart a scope
    // whose stores already landed.
    let revoked = std::env::var("BS_K3_REVOKE_PAGE")
        .ok()
        .and_then(|v| u32::from_str_radix(v.trim_start_matches("0x"), 16).ok());
    if let Some(page) = revoked {
        memory
            .set_permissions(page, 0x1000, false, false)
            .expect("revoked page in bounds");
    }

    // The ledger is what the machine COUNTED, never a literal: a constant here would agree with
    // the corpus's independent expectation no matter how much memory traffic the region actually
    // performed, which is the accounting-by-intent CLAUDE.md §3.4 forbids.
    let mut fault_report = String::from("null");
    let mut completed = 0usize;
    for _ in 0..count {
        match execute(&region, &mut machine, &mut memory) {
            ExecuteExit::Statepoint { .. } => completed += 1,
            ExecuteExit::Fault { fault, guest_eip, retired_instructions, effect_token } => {
                fault_report = format!(
                    "{{\"taken\":true,\"guest_eip\":{guest_eip},\"retired_before\":{retired_instructions},                     \"effects_before\":{effect_token},\"completed_iterations\":{completed},                     \"kind\":\"{}\",\"address\":{}}}",
                    match fault { MemoryFault::OutOfBounds { .. } => "out-of-bounds", MemoryFault::Permission { write: true, .. } => "permission-write", MemoryFault::Permission { .. } => "permission-read" },
                    match fault { MemoryFault::OutOfBounds { address, .. } | MemoryFault::Permission { address, .. } => address },
                );
                break;
            }
            other => panic!("unexpected exit {other:?}"),
        }
    }
    if revoked.is_some() && fault_report == "null" {
        // A revoked page that produced no fault means the scenario did not happen, which is not
        // the same as a clean run and must not be reported as one.
        println!("{{\"wire_version\":{WIRE_VERSION},\"status\":\"expected_fault_not_taken\"}}");
        std::process::exit(5);
    }
    let effects = machine.effects;
    println!(
        "{{\"wire_version\":{WIRE_VERSION},\"case\":\"k3\",\"status\":\"ok\",\"authority\":{{\"entry_eip\":{ENTRY},\"dst3\":{DST},\"source\":{SOURCE},\"k3_sha256\":\"{K3_SHA256}\"}},\"work\":{{\"calls\":1,\"body_iterations\":{count},\"body_instructions\":{},\"analytic_instructions\":{}}},\"dst3_hex\":\"{}\",\"gprs\":{},\"body_eip\":{},\"logical_continuation\":\"wrapper-return\",\"flags\":{},\"ledger\":{{\"effects\":{effects},\"accounting\":{}}},\"fault\":{fault_report}}}",
        count * 7, 3 + count * 7 + 1, dst_hex(&memory, count), gprs_json(&machine), machine.eip,
        flags_json(machine.flags), machine.accounting,
    );
}
