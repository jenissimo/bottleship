//! Stable, dependency-free wire adapter for one k8 call.
//!
//! Mirrors what the oracle image does: build the same guest memory, put the same cdecl frame on
//! the stack, run the lifted region, and print the architectural outcome as JSON. Everything the
//! differential compares comes out of here, so nothing about the comparison depends on this
//! crate and the JS harness agreeing on anything but the numbers.

use bottleship_opt_compiler::{
    execute, lift_k8, ExecuteExit, ExitReason, Flags, Gpr, Machine, Memory, K8_BYTES, K8_SHA256,
};

const WIRE_VERSION: u32 = 1;

// Mirrors `aot-oracle/corpus/layout.mjs`. `k8-differential.mjs` refuses to compare unless these
// match what the layout exports, so a drift is a refusal rather than a wrong answer.
const DATA: u32 = 0x0010_C000;
const ENTRY: u32 = DATA + 0x14000;
const SRC: u32 = DATA + 0x15000;
const DST: u32 = DATA + 0x16000;
const STACK_TOP: u32 = DATA;
const ROWS: u32 = 8;
const COLS: u32 = 8;
const ROW_DST_STRIDE: u32 = 0x40;
const SRC_STRIDE: u32 = 16;
const BIAS: u32 = 0x21;
const MEM_SIZE: usize = 0x0012_4000;

/// The stand-in return address the image's wrapper pushes.
///
/// The region MODELS its `ret`, so this is where the region leaves — which is what makes the
/// exit continuation a value the fixture chose rather than an address the lifter invented.
/// `[ebp+8]` lands on the first argument only because this word is on the stack.
const FAKE_RETURN: u32 = ENTRY + K8_BYTES.len() as u32;

fn flags_json(f: Flags) -> String {
    format!(
        "{{\"cf\":{},\"pf\":{},\"af\":{},\"zf\":{},\"sf\":{},\"of\":{}}}",
        f.cf, f.pf, f.af, f.zf, f.sf, f.of
    )
}

fn gprs_json(m: &Machine) -> String {
    format!(
        "{{\"eax\":{},\"ecx\":{},\"edx\":{},\"ebx\":{},\"esp\":{},\"ebp\":{},\"esi\":{},\"edi\":{}}}",
        m.get(Gpr::Eax), m.get(Gpr::Ecx), m.get(Gpr::Edx), m.get(Gpr::Ebx),
        m.get(Gpr::Esp), m.get(Gpr::Ebp), m.get(Gpr::Esi), m.get(Gpr::Edi),
    )
}

fn hex32(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let region = match lift_k8(ENTRY, &K8_BYTES) {
        Ok(region) => region,
        Err(e) => {
            println!("{{\"wire_version\":{WIRE_VERSION},\"status\":\"lift_failed\",\"why\":\"{e}\"}}");
            std::process::exit(3);
        }
    };

    let mut memory = Memory::new(MEM_SIZE);
    // Source bytes, by the same formula `layout.mjs` writes them with.
    for row in 0..ROWS {
        for col in 0..COLS {
            let value = ((row * 37 + col * 11 + 1) & 0xff) as u8;
            memory
                .write_u32(SRC + row * SRC_STRIDE + col, 0)
                .expect("source writable");
            memory.write_u8(SRC + row * SRC_STRIDE + col, value).expect("source writable");
        }
    }
    for i in 0..ROWS * (ROW_DST_STRIDE / 4) {
        memory.write_u32(DST + i * 4, 0).expect("destination writable");
    }

    // The cdecl frame the wrapper builds: arguments, then the stand-in return address on top, so
    // the body's own `push ebp; mov ebp,esp` puts `[ebp+8]` on the first argument.
    let esp = STACK_TOP - 20;
    for (i, value) in [FAKE_RETURN, SRC, SRC_STRIDE, DST, BIAS].iter().enumerate() {
        memory.write_u32(esp + (i as u32) * 4, *value).expect("stack writable");
    }

    let mut machine = Machine::default();
    machine.set(Gpr::Esp, esp);
    machine.eip = ENTRY;

    let exit = execute(&region, &mut machine, &mut memory);
    let (status, reason, continuation) = match exit {
        ExecuteExit::Statepoint { reason, continuation_eip } => ("ok", reason, continuation_eip),
        other => {
            println!(
                "{{\"wire_version\":{WIRE_VERSION},\"status\":\"abnormal\",\"why\":\"{other:?}\"}}"
            );
            std::process::exit(4);
        }
    };

    let mut dst = Vec::with_capacity((ROWS * ROW_DST_STRIDE) as usize);
    for i in 0..ROWS * ROW_DST_STRIDE {
        dst.push(memory.read_u8(DST + i).expect("destination readable"));
    }

    // `reason` is part of the contract, not decoration: the region is supposed to stop before the
    // instruction it does not model, and any other exit means it stopped somewhere else.
    let reason_name = match reason {
        ExitReason::UnsupportedInstruction => "unsupported-instruction",
        ExitReason::Fallthrough => "fallthrough",
        ExitReason::BranchTaken => "branch-taken",
        ExitReason::GuardMiss => "guard-miss",
        ExitReason::Fault => "fault",
        ExitReason::Budget => "budget",
    };
    println!(
        "{{\"wire_version\":{WIRE_VERSION},\"case\":\"k8\",\"status\":\"{status}\",\
         \"authority\":{{\"entry_eip\":{ENTRY},\"src\":{SRC},\"dst\":{DST},\"stack_top\":{STACK_TOP},\
         \"src_stride\":{SRC_STRIDE},\"bias\":{BIAS},\"rows\":{ROWS},\"cols\":{COLS},\
         \"row_dst_stride\":{ROW_DST_STRIDE},\"k8_sha256\":\"{sha}\"}},\
         \"exit\":{{\"reason\":\"{reason_name}\",\"continuation_eip\":{continuation}}},\
         \"work\":{{\"instructions\":{ins},\"effects\":{effects},\"accounting\":{accounting}}},\
         \"gprs\":{gprs},\"flags\":{flags},\"dst_hex\":\"{dst_hex}\"}}",
        sha = hex32(&K8_SHA256),
        ins = region.instructions.len(),
        effects = machine.effects,
        accounting = machine.accounting,
        gprs = gprs_json(&machine),
        flags = flags_json(machine.flags),
        dst_hex = hex32(&dst),
    );
}
