//! Lower whatever guest code is at a page entry, and describe the unit as JSON.
//!
//! The bytes come from a LIVE capture, not from a corpus constant: a unit is entered at the
//! offset the dispatcher looked up, so it must implement the instruction stream that is actually
//! there. A unit built from a kernel body while the entry holds a wrapper prologue runs the body
//! with whatever the wrapper was supposed to set up — which is how a clean-looking artifact
//! produces a #GP.
//!
//!   lower_entry <entry-eip-hex> <code-hex>

use bottleship_opt_compiler::{dead_flag_publications, lift_slice, lower_region_with, Passes, Scope};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // Named passes, so an artifact records which arm produced it rather than being described by
    // whoever reports the number.
    let mut passes = Passes::default();
    if let Some(at) = args.iter().position(|a| a == "--passes") {
        let list = match args.get(at + 1) {
            Some(list) => list.clone(),
            None => {
                println!("{{\"status\":\"bad_args\",\"why\":\"--passes needs a list\"}}");
                std::process::exit(2);
            }
        };
        match Passes::parse(&list) {
            Ok(p) => passes = p,
            Err(why) => {
                println!("{{\"status\":\"bad_args\",\"why\":\"{why}\"}}");
                std::process::exit(2);
            }
        }
        args.drain(at..=at + 1);
    }
    if args.len() < 2 || args.len() > 3 {
        println!("{{\"status\":\"bad_args\",\"why\":\"usage: lower_entry <entry-eip-hex> <code-hex> [loop-bound]\"}}");
        std::process::exit(2);
    }
    let loop_bound: i32 = match args.get(2) {
        None => 100_003,
        Some(v) => match v.parse() {
            Ok(n) if n > 0 => n,
            _ => {
                println!("{{\"status\":\"bad_args\",\"why\":\"loop bound must be a positive integer\"}}");
                std::process::exit(2);
            }
        },
    };
    let entry = match u32::from_str_radix(args[0].trim_start_matches("0x"), 16) {
        Ok(v) => v,
        Err(e) => {
            println!("{{\"status\":\"bad_args\",\"why\":\"entry eip: {e}\"}}");
            std::process::exit(2);
        }
    };
    let hex = args[1].as_bytes();
    if hex.len() % 2 != 0 {
        println!("{{\"status\":\"bad_args\",\"why\":\"code hex has an odd length\"}}");
        std::process::exit(2);
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for pair in hex.chunks_exact(2) {
        let s = std::str::from_utf8(pair).unwrap_or("zz");
        match u8::from_str_radix(s, 16) {
            Ok(b) => bytes.push(b),
            Err(_) => {
                println!("{{\"status\":\"bad_args\",\"why\":\"code hex is not hex\"}}");
                std::process::exit(2);
            }
        }
    }

    let region = match lift_slice(entry, &bytes) {
        Ok(r) => r,
        Err(e) => {
            println!("{{\"status\":\"lift_failed\",\"why\":\"{e}\"}}");
            std::process::exit(3);
        }
    };
    let lowered = match lower_region_with(&region, false, loop_bound, passes) {
        Ok(l) => l,
        Err(e) => {
            println!("{{\"status\":\"lower_failed\",\"why\":\"{e}\"}}");
            std::process::exit(4);
        }
    };

    // Why the scope pass did or did not fire. A pass that silently does nothing looks exactly
    // like a pass that is off, and every measurement of it then compares a unit with itself.
    let scope = format!("{:?}", Scope::explain(&region));
    // The instruction stream, so a report about indices can be read without a disassembler.
    let ops: Vec<String> = region
        .instructions
        .iter()
        .enumerate()
        .map(|(i, x)| {
            let name = format!("{:?}", x.opcode);
            let short = name.split(' ').next().unwrap_or("?").trim_end_matches('{').to_string();
            format!("\"{i}:{short}\"")
        })
        .collect();
    let dead: Vec<String> = dead_flag_publications(&region, true)
        .iter()
        .enumerate()
        .filter(|(_, d)| **d)
        .map(|(i, _)| i.to_string())
        .collect();
    let hex_out: String = lowered.unit.bytes.iter().map(|b| format!("{b:02x}")).collect();
    let sha: String = region.code_dependencies[0]
        .body_sha256
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let imports: Vec<String> = lowered.unit.imports.iter().map(|n| format!("\"{n}\"")).collect();
    // Page offsets, not addresses: the manifest names entries relative to the page the unit owns.
    let exit_eips: Vec<String> = region
        .exit_continuations()
        .iter()
        .map(|eip| eip.to_string())
        .collect();
    let unclaimable: Vec<String> = lowered
        .unclaimable_entries
        .iter()
        .map(|eip| (eip & 0xfff).to_string())
        .collect();
    let entries: Vec<String> = lowered
        .entries
        .iter()
        .map(|(eip, index)| format!("[{},{index}]", eip & 0xfff))
        .collect();
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
    println!(
        "{{\"status\":\"ok\",\"entry_eip\":{entry},\"instructions\":{},\
         \"lifted_sha256\":\"{sha}\",\"bytes\":{},\"body_start\":{},\"local_count\":{},\
         \"imports\":[{}],\"relocs\":[{}],\"entries\":[{}],\"unclaimable_entries\":[{}],\"exit_eips\":[{}],\"loop_bound\":{loop_bound},\"scope\":\"{scope}\",\"dead_publications\":[{}],\"ops\":[{}],\"passes\":[{}],\"hex\":\"{hex_out}\"}}",
        region.instructions.len(),
        lowered.unit.bytes.len(),
        lowered.unit.body_start,
        lowered.unit.local_count,
        imports.join(","),
        relocs.join(","),
        entries.join(","),
        unclaimable.join(","),
        exit_eips.join(","),
        dead.join(","),
        ops.join(","),
        passes
            .names()
            .iter()
            .map(|n| format!("\"{n}\""))
            .collect::<Vec<_>>()
            .join(","),
    );
}
