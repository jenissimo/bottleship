//! Semantic core for the experimental user-mode optimizing translator.
//!
//! This crate deliberately has no dependency on v86, JavaScript bindings, or a Wasm runtime.
//! It owns only a small, serializable-ish IR and the proof obligations that make the first
//! integer slice safe to lower.  Publication, guards, and baseline continuation stay outside
//! the crate until their runtime contracts exist.

pub mod contract;
pub mod decode;
pub mod decode_k8;
pub mod interpret;
pub mod flag_liveness;
pub mod scoped_memory;
pub mod lower_wasm;
pub mod sha256;
pub mod ir;
pub mod verify;
pub mod wasm;

pub use contract::*;
pub use decode::*;
pub use decode_k8::*;
pub use interpret::*;
pub use flag_liveness::*;
pub use scoped_memory::*;
pub use lower_wasm::*;
pub use sha256::sha256;
pub use ir::*;
pub use verify::*;

#[cfg(test)]
mod tests {
    use super::*;

    fn data(base: Gpr, index: Option<Gpr>, displacement: i32) -> Address {
        Address {
            base: Some(base),
            index,
            scale: 1,
            displacement,
            segment: Segment::DefaultData,
        }
    }

    /// P1's semantic target is the real retail k3 body, not an invented benchmark kernel.
    /// A machine and memory seeded exactly as `k3_wire` seeds them, so a test and the wire
    /// adapter cannot disagree about what k3 was run against.
    fn k3_machine() -> (Machine, Memory) {
        const DST: u32 = 0x0011_2800;
        const SOURCE: u32 = 0x0010_d000;
        let mut memory = Memory::new(0x0012_4000);
        let mut state = 0x00c0_ffee_u32;
        for i in 0..64u32 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let word = if state % 3 == 0 { 0 } else { state };
            memory.write_u32(SOURCE + i * 4, word).expect("source writable");
            memory.write_u32(DST + i * 4, 0).expect("destination writable");
        }
        let mut machine = Machine::default();
        machine.set(Gpr::Ecx, DST);
        machine.set(Gpr::Edi, SOURCE.wrapping_sub(DST));
        machine.set(Gpr::Eax, 64);
        machine.eip = 0x0010_3000;
        (machine, memory)
    }

    /// The same, for k8's cdecl frame.
    fn k8_machine() -> (Machine, Memory) {
        const DATA: u32 = 0x0010_C000;
        const ENTRY: u32 = DATA + 0x14000;
        const SRC: u32 = DATA + 0x15000;
        const DST: u32 = DATA + 0x16000;
        const STACK_TOP: u32 = DATA;
        let mut memory = Memory::new(0x0012_4000);
        for row in 0..8u32 {
            for col in 0..8u32 {
                let value = ((row * 37 + col * 11 + 1) & 0xff) as u8;
                memory.write_u8(SRC + row * 16 + col, value).expect("source writable");
            }
        }
        let esp = STACK_TOP - 20;
        for (i, value) in [ENTRY + 209, SRC, 16, DST, 0x21].iter().enumerate() {
            memory.write_u32(esp + (i as u32) * 4, *value).expect("stack writable");
        }
        let mut machine = Machine::default();
        machine.set(Gpr::Esp, esp);
        machine.eip = ENTRY;
        (machine, memory)
    }

    fn k3() -> Region {
        let entry = 0x0010_3000;
        let reconstruction = Reconstruction {
            gprs: [
                ValueRef::InstructionResult { instruction: 5 },
                ValueRef::InstructionResult { instruction: 4 },
                ValueRef::InstructionResult { instruction: 2 },
                ValueRef::InputGpr(Gpr::Ebx),
                ValueRef::InputGpr(Gpr::Esp),
                ValueRef::InputGpr(Gpr::Ebp),
                ValueRef::InputGpr(Gpr::Esi),
                ValueRef::InputGpr(Gpr::Edi),
            ],
            flags: k3_dec_flag_recipe(),
            effect_token: 2,
        };
        let ops = vec![
            Opcode::Xor32 {
                dst: Gpr::Edx,
                src: Gpr::Edx,
            },
            Opcode::CompareMem32Reg {
                address: data(Gpr::Ecx, Some(Gpr::Edi), 0),
                rhs: Gpr::Edx,
            },
            Opcode::SetCondition8 {
                dst: Gpr::Edx,
                part: RegisterPart::Low8,
                condition: Condition::NotEqual,
            },
            Opcode::Store32 {
                address: data(Gpr::Ecx, None, 0),
                src: Gpr::Edx,
            },
            Opcode::Add32Immediate {
                dst: Gpr::Ecx,
                value: 4,
            },
            Opcode::Decrement32 { dst: Gpr::Eax },
            Opcode::BranchIf {
                condition: Condition::NotEqual,
                taken: Continuation::Exit(Statepoint {
                    continuation_eip: entry,
                    accounting_delta: AccountingDelta::Fixed(7),
                    reason: ExitReason::BranchTaken,
                    reconstruction,
                }),
                fallthrough: Continuation::Exit(Statepoint {
                    continuation_eip: entry + 16,
                    accounting_delta: AccountingDelta::Fixed(7),
                    reason: ExitReason::Fallthrough,
                    reconstruction,
                }),
            },
        ];
        let eips = [
            entry,
            entry + 2,
            entry + 5,
            entry + 8,
            entry + 10,
            entry + 13,
            entry + 14,
        ];
        let mut effect = 0;
        let instructions = ops
            .into_iter()
            .enumerate()
            .map(|(index, opcode)| {
                let next_effect = effect + u32::from(opcode.has_memory_effect());
                let instruction = Instruction {
                    guest_eip: eips[index],
                    state_in: index as u32,
                    state_out: index as u32 + 1,
                    effect_in: effect,
                    effect_out: next_effect,
                    opcode,
                };
                effect = next_effect;
                instruction
            })
            .collect();
        Region {
            ir_version: IR_VERSION,
            keeps_state_canonical: true,
            envelope: Envelope::integer_slice_v1(true, true),
            entry_eip: entry,
            code_dependencies: vec![CodeDependency {
                guest_page: entry >> 12,
                body_sha256: [
                    0xf9, 0x2e, 0x8a, 0xd0, 0x0d, 0x11, 0x2b, 0xc4, 0x6e, 0xa8, 0xba, 0xb9, 0xfd,
                    0x40, 0x14, 0x10, 0xe4, 0xce, 0xfc, 0x3b, 0x9a, 0xd8, 0xff, 0x4a, 0x21, 0xbe,
                    0x9d, 0x67, 0xd4, 0x4a, 0xe3, 0x45,
                ],
            }],
            instructions,
        }
    }

    #[test]
    fn envelope_refuses_a_storing_region_that_never_promised_a_code_write_barrier() {
        let mut region = k3();
        region.envelope.dependencies.retain(|d| *d != DependencyKind::NoCodeWriteBarrier);
        assert_eq!(
            verify(&region),
            Err(VerifyError::Envelope(EnvelopeError::MissingDependency(
                DependencyKind::NoCodeWriteBarrier
            )))
        );
    }

    #[test]
    fn envelope_refuses_a_memory_region_that_never_promised_its_mapping() {
        for missing in [DependencyKind::MappingAndPermissions, DependencyKind::OrdinaryRam] {
            let mut region = k3();
            region.envelope.dependencies.retain(|d| *d != missing);
            assert_eq!(
                verify(&region),
                Err(VerifyError::Envelope(EnvelopeError::MissingDependency(missing)))
            );
        }
    }

    #[test]
    fn envelope_refuses_code_bytes_or_segment_state_being_dropped() {
        for missing in [DependencyKind::CodeBytes, DependencyKind::SegmentState] {
            let mut region = k3();
            region.envelope.dependencies.retain(|d| *d != missing);
            assert_eq!(
                verify(&region),
                Err(VerifyError::Envelope(EnvelopeError::MissingDependency(missing)))
            );
        }
    }

    #[test]
    fn envelope_refuses_a_dependency_list_that_is_not_canonical() {
        let mut region = k3();
        region.envelope.dependencies.reverse();
        assert_eq!(
            verify(&region),
            Err(VerifyError::Envelope(EnvelopeError::UnsortedDependencies))
        );

        let mut region = k3();
        region.envelope.dependencies.push(DependencyKind::CodeBytes);
        region.envelope.dependencies.sort();
        assert_eq!(
            verify(&region),
            Err(VerifyError::Envelope(EnvelopeError::DuplicateDependency(
                DependencyKind::CodeBytes
            )))
        );
    }

    #[test]
    fn envelope_refuses_a_version_it_does_not_understand() {
        let mut region = k3();
        region.envelope.envelope_version = ENVELOPE_VERSION + 1;
        assert_eq!(
            verify(&region),
            Err(VerifyError::Envelope(EnvelopeError::UnsupportedVersion(
                ENVELOPE_VERSION + 1
            )))
        );
    }

    #[test]
    fn a_region_without_memory_owes_fewer_preconditions() {
        // The check would be unable to fail for the regions that matter if every region were
        // required to declare everything: an envelope must track what the region actually does.
        let none = Envelope::integer_slice_v1(false, false);
        assert!(!none.requires(DependencyKind::MappingAndPermissions));
        assert!(!none.requires(DependencyKind::NoCodeWriteBarrier));
        assert!(none.requires(DependencyKind::CodeBytes));
        assert!(none.validate(false, false).is_ok());
        // ...and that lighter envelope is NOT acceptable for a region that does touch memory.
        assert_eq!(
            none.validate(true, false),
            Err(EnvelopeError::MissingDependency(DependencyKind::MappingAndPermissions))
        );
    }

    #[test]
    fn the_lifter_derives_an_envelope_that_matches_what_it_lifted() {
        let region = lift_k3(0x0010_3000, &K3_BYTES).expect("k3 lifts");
        assert!(region.touches_memory() && region.stores_to_memory());
        assert!(region.envelope.requires(DependencyKind::NoCodeWriteBarrier));
        // FS is deliberately outside the segment model: it is switched per thread, so no region
        // may fold it in.
        assert_eq!(region.envelope.segments, SegmentModel::FlatDataSegments);
        assert_eq!(region.envelope.fp_policy, FpPolicy::Untouched);
    }

    // ── k8: the kernel selected by measured CPU-time ──────────────────────────────────────
    #[test]
    fn lifts_the_byte_exact_retail_k8_body() {
        let region = lift_k8(0x0064_a71f, &K8_BYTES).expect("k8 lifts");
        // 67 modelled instructions plus the exit that stands in for `ret`.
        assert_eq!(region.instructions.len(), 68);
        assert_eq!(region.entry_eip, 0x0064_a71f);
        assert_eq!(region.code_dependencies[0].body_sha256, K8_SHA256);
        assert!(region.touches_memory() && region.stores_to_memory());
    }

    #[test]
    fn k8_keeps_its_loop_inside_the_region() {
        let region = lift_k8(0x0064_a71f, &K8_BYTES).unwrap();
        let back_edges = region.instructions.iter().filter(|i| {
            matches!(i.opcode, Opcode::Jump { target: Continuation::InRegion { .. } })
        }).count();
        let internal_branches = region.instructions.iter().filter(|i| matches!(
            i.opcode,
            Opcode::BranchIf { taken: Continuation::InRegion { .. }, fallthrough: Continuation::InRegion { .. }, .. }
        )).count();
        // The whole point of `Continuation::InRegion`: a region that left on every iteration
        // would be correct and would measure nothing but its own entry cost.
        assert_eq!(back_edges, 2, "the initial jmp into the test and the loop's back edge");
        assert_eq!(internal_branches, 1, "the loop test");
        assert!(region.instructions.iter().all(|i| !matches!(
            i.opcode,
            Opcode::BranchIf { taken: Continuation::Exit(_), .. }
        )));
    }


    /// The first statepoint in a region, wherever it lives.
    ///
    /// Reaching for `instructions.last()` and pattern-matching an `Exit` looked equivalent and was
    /// not: the moment the last instruction became a modelled terminator, the `if let` stopped
    /// matching, no mutation happened, and every test built that way asserted a rejection of code
    /// nobody had corrupted.
    fn first_statepoint_mut(region: &mut Region) -> &mut Statepoint {
        for instruction in &mut region.instructions {
            match &mut instruction.opcode {
                Opcode::Exit(point) => return point,
                Opcode::Jump { target: Continuation::Exit(point) } => return point,
                Opcode::BranchIf { taken: Continuation::Exit(point), .. } => return point,
                Opcode::BranchIf { fallthrough: Continuation::Exit(point), .. } => return point,
                _ => {}
            }
        }
        panic!("the region has no statepoint to corrupt");
    }

    /// k8, with its modelled `ret` put back as an unsupported boundary.
    ///
    /// The lifted region has no statepoint at all — every edge is in-region and the return is
    /// modelled — so a test about statepoint validation has to construct the shape it is about
    /// rather than assume the lifter still produces it.
    fn k8_with_a_boundary_return() -> Region {
        let mut region = lift_k8(0x0064_a71f, &K8_BYTES).unwrap();
        let last = region.instructions.len() - 1;
        let instruction = &mut region.instructions[last];
        let effect_in = instruction.effect_in;
        instruction.effect_out = effect_in;
        instruction.opcode = Opcode::Exit(Statepoint {
            continuation_eip: instruction.guest_eip,
            accounting_delta: AccountingDelta::Retired,
            reason: ExitReason::UnsupportedInstruction,
            reconstruction: Reconstruction {
                gprs: [
                    ValueRef::LiveGpr(Gpr::Eax), ValueRef::LiveGpr(Gpr::Ecx),
                    ValueRef::LiveGpr(Gpr::Edx), ValueRef::LiveGpr(Gpr::Ebx),
                    ValueRef::LiveGpr(Gpr::Esp), ValueRef::LiveGpr(Gpr::Ebp),
                    ValueRef::LiveGpr(Gpr::Esi), ValueRef::LiveGpr(Gpr::Edi),
                ],
                flags: FlagRecipe::Live,
                effect_token: effect_in,
            },
        });
        region
    }

    #[test]
    fn k8_ends_with_a_modelled_return_not_a_boundary() {
        // A `ret` left as an unsupported boundary sets EIP to its own address and leaves, so an
        // engine that dispatches there re-enters, leaves, and spins without retiring anything.
        let region = lift_k8(0x0064_a71f, &K8_BYTES).unwrap();
        let last = region.instructions.last().unwrap();
        assert_eq!(last.opcode, Opcode::Return { pop: 0 });
        assert_eq!(last.guest_eip, 0x0064_a71f + K8_BYTES.len() as u32 - 1);
        assert!(last.opcode.is_terminal() && last.opcode.has_memory_effect());
    }

    #[test]
    fn an_instruction_the_slice_does_not_model_ends_the_region_at_itself() {
        // `xor eax, ecx` then an opcode this slice has no semantics for: the region keeps what it
        // understands and hands the rest back at the address of the instruction it declined.
        // k3's retail body with its `ret` replaced by an opcode this slice has no semantics for.
        // The boundary lands after the loop's branch, so it is a BLOCK HEAD — which is the case
        // that matters: a head the engine could dispatch to, that retires nothing.
        let mut bytes = K3_BYTES.to_vec();
        let boundary_eip = 0x1000 + bytes.len() as u32;
        bytes.extend_from_slice(&[0x0f, 0x31]);
        let region = lift_slice(0x1000, &bytes).expect("the prefix lifts");
        let last = region.instructions.last().unwrap();
        match &last.opcode {
            Opcode::Exit(point) => {
                assert_eq!(point.reason, ExitReason::UnsupportedInstruction);
                // The declined instruction itself, not the byte after it: the baseline executes it.
                assert_eq!(point.continuation_eip, boundary_eip);
            }
            other => panic!("expected a boundary Exit, got {other:?}"),
        }
        // Its block is not offered as an entry: entering there would retire nothing.
        let lowered = lower_region(&region, false).expect("the prefix lowers");
        assert_eq!(lowered.unclaimable_entries, vec![boundary_eip]);
        assert!(lowered.entries.iter().all(|(eip, _)| *eip != boundary_eip));
        // A straight-line prefix ending in a boundary is NOT a head, so nothing is withheld.
        let plain = lift_slice(0x2000, &[0x33, 0xc1, 0x0f, 0x31]).expect("lifts");
        assert!(lower_region(&plain, false).unwrap().unclaimable_entries.is_empty());
    }

    #[test]
    fn a_region_that_models_nothing_is_refused_rather_than_lifted() {
        // The first instruction being unsupported would make the whole region a zero-progress
        // entry, which is the host loop above with extra steps.
        assert!(matches!(
            lift_slice(0x1000, &[0x0f, 0x31, 0xc3]),
            Err(LiftError::Unsupported { .. })
        ));
    }

    #[test]
    fn a_kernel_named_lifter_refuses_bytes_that_are_not_that_kernel() {
        // Otherwise a modified program is published under the original's identity, and every
        // content-binding check downstream answers "unchanged" about different code.
        let mut altered = K8_BYTES;
        altered[25] = 9; // the loop bound: `cmp dword [ebp-4], 8` becomes 9
        assert_eq!(lift_k8(0x0064_a71f, &altered), Err(LiftError::BodyMismatch));
    }

    #[test]
    fn a_lifted_region_records_the_identity_of_the_bytes_it_consumed() {
        // The general entry point lifts whatever it is given — and says so, by hashing it.
        let mut altered = K8_BYTES.to_vec();
        altered[25] = 9;
        let changed = lift_slice(0x0064_a71f, &altered).expect("still a supported slice");
        let original = lift_k8(0x0064_a71f, &K8_BYTES).unwrap();
        assert_ne!(
            changed.code_dependencies[0].body_sha256,
            original.code_dependencies[0].body_sha256,
            "different instructions must not share an identity"
        );
        assert_eq!(original.code_dependencies[0].body_sha256, K8_SHA256);
        // ...and the hash is of what was CONSUMED, not of the buffer handed in.
        let mut padded = K8_BYTES.to_vec();
        padded.extend_from_slice(&[0x90; 16]);
        let trailing = lift_slice(0x0064_a71f, &padded).unwrap();
        assert_eq!(trailing.code_dependencies[0].body_sha256, K8_SHA256);
    }

    #[test]
    fn the_decoder_handles_the_addressing_forms_both_real_kernels_use() {
        // k3's compare is `cmp [ecx+edi], edx` — a SIB operand, which k8 never uses.
        let region = lift_slice(0x0010_3000, &K3_BYTES).expect("k3 lifts through the slice decoder");
        let compare = region
            .instructions
            .iter()
            .find_map(|i| match &i.opcode {
                Opcode::CompareMem32Reg { address, .. } => Some(*address),
                _ => None,
            })
            .expect("k3 compares memory against a register");
        assert_eq!(compare.base, Some(Gpr::Ecx));
        assert_eq!(compare.index, Some(Gpr::Edi));
        assert_eq!(compare.scale, 1);
    }

    #[test]
    fn the_decoder_still_refuses_forms_it_does_not_model() {
        // disp32-only (mod=00, rm=101) has no base register to add.
        assert!(matches!(
            lift_slice(0x1000, &[0x8b, 0x05, 0, 0, 0, 0]),
            Err(LiftError::Unsupported { .. })
        ));
        // A SIB with no base is the same problem one level down.
        assert!(matches!(
            lift_slice(0x1000, &[0x8b, 0x04, 0x25, 0, 0, 0, 0]),
            Err(LiftError::Unsupported { .. })
        ));
        assert!(matches!(lift_slice(0x1000, &[0x8b]), Err(LiftError::Truncated { .. })));
        assert!(matches!(
            lift_slice(0x1000, &[0xd9, 0x00]),
            Err(LiftError::Unsupported { byte: 0xd9, .. })
        ));
    }

    #[test]
    fn a_budget_exit_leaves_state_a_caller_can_resume_from() {
        // `add eax, 1` then a boundary, with room for exactly one instruction.
        let region = lift_slice(0x1000, &[0x83, 0xc0, 0x01, 0xc3]).expect("lifts");
        let mut memory = Memory::new(0x2000);
        let mut machine = Machine::default();
        machine.eip = 0x1000;
        match execute_with_budget(&region, &mut machine, &mut memory, 1) {
            ExecuteExit::BudgetExhausted { retired, guest_eip } => {
                assert_eq!(retired, 1);
                // EIP names the instruction that did NOT run, and the counter carries the one
                // that did. Without both, resuming re-executes work already performed.
                assert_eq!(guest_eip, 0x1003);
                assert_eq!(machine.eip, 0x1003);
                assert_eq!(machine.accounting, 1);
                assert_eq!(machine.get(Gpr::Eax), 1);
            }
            other => panic!("expected a budget exit, got {other:?}"),
        }
    }

    #[test]
    fn popping_into_esp_keeps_the_loaded_value_not_the_increment() {
        // x86 discards the stack-pointer increment for `pop esp`; writing the destination first
        // discards the load instead, and the guest continues on a stack that never existed.
        let region = lift_slice(0x1000, &[0x5c, 0xc3]).expect("pop esp lifts");
        let mut memory = Memory::new(0x2000);
        memory.write_u32(0x100, 0x300).unwrap();
        // The `ret` that follows reads through whatever ESP ends up holding, which is what makes
        // the two orders distinguishable: 0x300 is the loaded value, 0x104 the discarded increment.
        memory.write_u32(0x300, 0xaaaa).unwrap();
        memory.write_u32(0x104, 0xbbbb).unwrap();
        let mut machine = Machine::default();
        machine.set(Gpr::Esp, 0x100);
        machine.eip = 0x1000;
        match execute(&region, &mut machine, &mut memory) {
            ExecuteExit::Statepoint { continuation_eip, .. } => {
                assert_eq!(continuation_eip, 0xaaaa);
                assert_eq!(machine.get(Gpr::Esp), 0x304);
            }
            other => panic!("unexpected {other:?}"),
        }
        // A pop into any other register still advances the stack pointer.
        let region = lift_slice(0x1000, &[0x58, 0xc3]).expect("pop eax lifts");
        let mut machine = Machine::default();
        machine.set(Gpr::Esp, 0x100);
        machine.eip = 0x1000;
        execute(&region, &mut machine, &mut memory);
        assert_eq!(machine.get(Gpr::Eax), 0x300);
        // 0x104 after the pop, then the `ret` consumes its own return address.
        assert_eq!(machine.get(Gpr::Esp), 0x108);
    }


    #[test]
    fn k8_lifted_body_matches_the_disassembly_it_was_selected_for() {
        let region = lift_k8(0x0064_a71f, &K8_BYTES).unwrap();
        // The redundancy the kernel was chosen for, counted rather than asserted in prose:
        // eight elements, each reloading src and dst from the frame.
        let frame_loads = region.instructions.iter().filter(|i| matches!(
            i.opcode,
            Opcode::Load32 { address: Address { base: Some(Gpr::Ebp), .. }, .. }
        )).count();
        let byte_loads = region.instructions.iter().filter(|i| matches!(i.opcode, Opcode::LoadZeroExtendByte { .. })).count();
        let stores = region.instructions.iter().filter(|i| matches!(i.opcode, Opcode::Store32 { .. })).count();
        assert_eq!(byte_loads, 8, "one source byte per unrolled element");
        assert_eq!(stores, 8 + 3, "eight element stores plus the loop counter and the two advances");
        // [ebp-4] once, then per element [ebp+8] and [ebp+0x10], then the advance's three.
        assert_eq!(frame_loads, 1 + 8 * 2 + 2);
    }

    #[test]
    fn an_optimizing_region_may_not_claim_state_is_already_canonical() {
        let mut region = k8_with_a_boundary_return();
        region.keeps_state_canonical = false;
        assert!(matches!(
            verify(&region),
            Err(VerifyError::LiveStateWithoutCanonicalClaim { .. })
        ));
    }

    #[test]
    fn accepts_real_k3_shape_with_fault_ordered_effects() {
        verify(&k3()).unwrap();
    }

    #[test]
    fn rejects_memory_effect_reordering() {
        let mut region = k3();
        region.instructions[3].effect_in = 0;
        region.instructions[3].effect_out = 1;
        assert!(matches!(
            verify(&region),
            Err(VerifyError::BrokenEffectChain { at: 3, .. })
        ));
    }

    #[test]
    fn the_conservative_lowering_emits_a_module_for_k3() {
        let region = lift_k3(0x0010_3000, &K3_BYTES).unwrap();
        let lowered = lower_region(&region, false).expect("k3 lowers");
        // One helper per access kind, plus the fault and accounting helpers. A unit importing a
        // name it never calls would still link, but every import is a name the engine must
        // export, so the set is part of what the artifact promises.
        assert_eq!(
            lowered.unit.imports,
            vec![
                "safe_read32s_slow_jit".to_string(),
                "safe_write32_slow_jit".to_string(),
                "trigger_fault_end_jit".to_string(),
                "jit_tier2_note_aot_retired".to_string(),
            ]
        );
        // One TLB probe per access, never hoisted or shared (contract D7).
        assert_eq!(lowered.unit.relocs.len(), 2);
        assert!(lowered.unit.relocs.iter().all(|r| r.kind == "tlb_data" && r.width == 5));
        // Both exits credit the same seven instructions k3 retires.
        assert_eq!(lowered.exit_deltas, vec![7, 7]);
    }

    #[test]
    fn the_lowering_emits_a_dispatcher_for_a_region_with_a_loop() {
        // k8 owns a back edge. Lowering it as straight-line code would run the body once and
        // report a whole loop's worth of work, so the edge has to become a real re-dispatch.
        let region = lift_k8(0x0064_a71f, &K8_BYTES).unwrap();
        let lowered = lower_region(&region, false).expect("k8 lowers through the dispatcher");
        assert!(lowered.unit.bytes.len() > 0);
        // Its exits are dynamic, so it declares no fixed deltas.
        assert!(lowered.exit_deltas.is_empty() || lowered.exit_deltas.iter().all(|d| *d > 0));
    }

    #[test]
    fn only_the_flag_bits_a_condition_reads_are_demanded() {
        // k3 asks two questions and both are "is it zero": `setne` after the compare and the
        // loop `jnz`. Everything else the compare, the add and the dec define is dead — and PF
        // alone is a seven-instruction fold.
        let region = k3();
        let facts = FlagFacts::of(&region);
        let writers: Vec<i32> = region
            .instructions
            .iter()
            .enumerate()
            .filter(|(_, i)| i.opcode.writes_flags())
            .map(|(index, _)| facts.demanded_after[index])
            .collect();
        assert!(!writers.is_empty());
        for demanded in &writers {
            // ZF for the two conditions, and CF because `dec` PRESERVES it — a preserved flag is
            // a read: it has to be materialized into `flags` before the lazy word stops claiming
            // it, or the guest reads a CF from two operations ago.
            assert_eq!(demanded & !(flag::ZERO | flag::CARRY), 0, "nothing else is read back");
        }
        // Both outcomes occur, which is what makes the analysis worth running: the compare and
        // the decrement feed something, while the pointer advance between them feeds nothing.
        assert!(writers.iter().any(|d| *d & flag::ZERO != 0));
        assert!(writers.contains(&0));
        // And nothing is live at the entry: every condition is preceded by its own writer.
        assert_eq!(facts.live_before[0], 0);
    }

    #[test]
    fn a_signed_condition_demands_sign_and_overflow() {
        // The masks are not interchangeable: a signed test reads SF and OF, so a pass that only
        // ever kept ZF would branch on a bit the operation never wrote.
        let mut region = k3();
        let mut patched = false;
        for instruction in &mut region.instructions {
            if let Opcode::BranchIf { condition, .. } = &mut instruction.opcode {
                *condition = Condition::GreaterOrEqualSigned;
                patched = true;
            }
        }
        assert!(patched, "k3 has a conditional branch to repoint");
        let facts = FlagFacts::of(&region);
        let demanded = region
            .instructions
            .iter()
            .enumerate()
            .filter(|(_, i)| i.opcode.writes_flags())
            .map(|(index, _)| facts.demanded_after[index])
            .fold(0, |a, b| a | b);
        assert_eq!(demanded & (flag::SIGN | flag::OVERFLOW), flag::SIGN | flag::OVERFLOW);
    }

    #[test]
    fn an_entry_whose_condition_reads_flags_it_does_not_set_is_refused() {
        // The materialized flag word is private to one activation and starts at zero, so a
        // condition reached before any writer would branch on nothing. This is a property of the
        // shape, so the refusal must not depend on the pass being on.
        // `setne dl` with no flag writer before it, then a return.
        let region = lift_slice(0x1000, &[0x0f, 0x95, 0xc2, 0xc3]).expect("lifts");
        let facts = FlagFacts::of(&region);
        assert_eq!(facts.live_before[0], flag::ZERO);
        for passes in [Passes::default(), Passes { flag_liveness: true, ..Passes::default() }] {
            assert!(matches!(
                lower_region_with(&region, false, 100_003, passes),
                Err(LowerError::UnsupportedShape(_))
            ));
        }
    }

    #[test]
    fn flag_liveness_removes_work_without_changing_the_shape() {
        let region = k3();
        let plain = lower_region(&region, false).expect("k3 lowers");
        let lean = lower_region_with(&region, false, 100_003, Passes { flag_liveness: true, ..Passes::default() })
            .expect("k3 lowers with liveness");
        assert!(lean.unit.bytes.len() < plain.unit.bytes.len());
        // The pass removes computation, not structure: same entries, same exits, same counters.
        assert_eq!(lean.entries, plain.entries);
        assert_eq!(lean.exit_deltas, plain.exit_deltas);
        assert_eq!(lean.unit.imports, plain.unit.imports);
        assert_eq!(lean.unit.relocs.len(), plain.unit.relocs.len());
    }

    /// k3 as the ENGINE sees it: the general lifter keeps the back edge inside the region, while
    /// the pinned `lift_k3` models one iteration with both branch edges leaving.
    fn k3_loop() -> Region {
        lift_slice(0x1000, &K3_BYTES).expect("the k3 body lifts")
    }

    #[test]
    fn k3_loop_is_a_provable_scope() {
        // Two ranges: the compare reads through `ecx+edi`, the store writes through `ecx`, and
        // `ecx` is the pointer the loop advances by four.
        let region = k3_loop();
        let scope = Scope::of(&region).expect("k3 has a bounded loop");
        assert_eq!(scope.trip_counter, Some(Gpr::Eax));
        assert_eq!(scope.ranges.len(), 2);
        assert!(scope.ranges.iter().all(|r| r.induction == Some(Gpr::Ecx) && r.stride == 4));
        assert_eq!(scope.ranges.iter().filter(|r| r.writes).count(), 1);
        // The scope is exactly the loop: it ends at the back edge and covers nothing past it.
        assert!(scope.covers(scope.head as usize));
        assert!(scope.covers(scope.latch as usize));
        assert!(!scope.covers(scope.latch as usize + 1));
        match &region.instructions[scope.latch as usize].opcode {
            Opcode::BranchIf { taken: Continuation::InRegion { instruction }, .. } => {
                assert_eq!(*instruction, scope.head, "the scope head is the back edge target");
            }
            other => panic!("expected the latch to be the loop branch, got {other:?}"),
        }
    }

    #[test]
    fn an_access_after_the_advance_starts_a_stride_further_on() {
        // `add ecx,4; mov edx,[ecx]; dec eax; jnz`. The guard runs at the loop head, so on the
        // first iteration this access is at `ecx + 4`, not at `ecx`. A range sized from the head
        // proves one page and the loop reads the next one unchecked.
        let region = lift_slice(0x1000, &[0x83, 0xc1, 0x04, 0x8b, 0x11, 0x48, 0x75, 0xf8])
            .expect("lifts");
        let scope = Scope::of(&region).expect("a bounded loop");
        assert_eq!(scope.ranges.len(), 1);
        assert_eq!(scope.ranges[0].advances_before, 1);
        assert_eq!(scope.ranges[0].stride, 4);

        // The same instructions in the other order start where the guard looks.
        let before = lift_slice(0x1000, &[0x8b, 0x11, 0x83, 0xc1, 0x04, 0x48, 0x75, 0xf8])
            .expect("lifts");
        assert_eq!(Scope::of(&before).unwrap().ranges[0].advances_before, 0);
    }

    #[test]
    fn a_scaled_index_moves_the_address_by_the_scale() {
        // `mov edx,[ecx+edi*4]; add edi,4; dec eax; jnz`. The register advances by four, the
        // ADDRESS by sixteen. A range sized by the register's own stride covers a quarter of what
        // the loop reads, which is a proof about pages it does not stay on.
        let region = lift_slice(0x1000, &[
            0x8b, 0x14, 0xb9, 0x83, 0xc7, 0x04, 0x48, 0x75, 0xf7,
        ]).expect("lifts");
        let scope = Scope::of(&region).expect("a bounded loop");
        assert_eq!(scope.ranges.len(), 1);
        assert_eq!(scope.ranges[0].induction, Some(Gpr::Edi));
        assert_eq!(scope.ranges[0].stride, 16, "the scale multiplies the register's stride");
    }

    #[test]
    fn flags_in_locals_actually_changes_the_artifact() {
        // A pass that silently does nothing is indistinguishable from a pass that is off, and
        // every measurement of it then compares a unit with itself. What the pass DOES is checked
        // behaviourally by the exit matrices (faults after arithmetic, budget exit, baseline
        // continuation); this only refuses the silent no-op.
        let region = lift_k8(0x0064_a71f, &K8_BYTES).unwrap();
        let base = Passes { flag_liveness: true, scoped_memory: true, ..Passes::default() };
        let with = Passes { flags_in_locals: true, ..base };
        let a = lower_region_with(&region, false, 100_003, base).expect("lowers");
        let b = lower_region_with(&region, false, 100_003, with).expect("lowers");
        assert!(b.unit.bytes.len() < a.unit.bytes.len(),
            "the tuple moved to locals, so the body must shrink: {} vs {}",
            b.unit.bytes.len(), a.unit.bytes.len());
    }

    #[test]
    fn the_k8_scope_proves_the_frame_slots_and_nothing_else() {
        // The measured C+M arm on k8 rests on this shape: 32 ranges, every one of them an
        // INVARIANT frame slot, and no moving range at all. An analysis change that quietly proves
        // fewer — or more — makes the recorded number describe a different unit, and nothing else
        // in the gate would notice.
        let region = lift_k8(0x0064_a71f, &K8_BYTES).unwrap();
        assert_eq!(
            Scope::explain(&region),
            ScopeOutcome::Formed { head: 5, latch: 64, ranges: 32, invariant: 32 },
        );
        let scope = Scope::of(&region).expect("k8 has a scope");
        assert!(scope.ranges.iter().all(|r| r.stride == 0 && r.advances_before == 0));
    }

    #[test]
    fn a_branch_that_skips_the_advance_refuses_the_moving_range() {
        // `add edx,1; jnz +3; add ecx,4; mov edx,[ecx]; mov esi,[edi]; dec eax; jnz`.
        //
        // The advance SITS before the access and is not always executed before it. Counting
        // instructions by position says the pointer has moved a stride when it has not, and the
        // guard then proves the page above the one the access reads.
        let region = lift_slice(0x1000, &[
            0x83, 0xc2, 0x01, 0x75, 0x03, 0x83, 0xc1, 0x04,
            0x8b, 0x11, 0x8b, 0x37, 0x48, 0x75, 0xf1,
        ]).expect("lifts");
        let scope = Scope::of(&region).expect("a bounded loop");
        assert_eq!(scope.ranges.len(), 1, "only the invariant access survives");
        assert_eq!(scope.ranges[0].induction, None);
        assert!(!scope.ranges.iter().any(|r| r.induction == Some(Gpr::Ecx)),
            "the range whose start depends on the path taken is left guarded");

        // The same loop with the branch removed proves both, so the refusal is about the branch
        // and not about the shape.
        let straight = lift_slice(0x1000, &[
            0x83, 0xc2, 0x01, 0x83, 0xc1, 0x04,
            0x8b, 0x11, 0x8b, 0x37, 0x48, 0x75, 0xf3,
        ]).expect("lifts");
        let straight = Scope::of(&straight).expect("a bounded loop");
        assert_eq!(straight.ranges.len(), 2);
        let moving = straight.ranges.iter().find(|r| r.induction == Some(Gpr::Ecx)).expect("moving");
        assert_eq!(moving.advances_before, 1);
    }

    #[test]
    fn a_stride_that_is_not_a_whole_access_is_declined() {
        // The scope proves alignment ONCE, at entry. A stride that is not a multiple of the
        // access width drifts the alignment, and with it whether a later access crosses a page —
        // which the proven path cannot handle, because two adjacent virtual pages are not two
        // adjacent physical ones.
        let region = lift_slice(0x1000, &[0x83, 0xc1, 0x02, 0x8b, 0x11, 0x48, 0x75, 0xf8])
            .expect("lifts");
        assert!(Scope::of(&region).is_none());
    }

    #[test]
    fn a_counter_something_else_writes_is_not_a_trip_count() {
        // `dec eax; add eax,1; jnz` decrements and undoes it, and the branch reads the ADD's
        // flags. The loop does not run `eax` times, so a range sized from `eax` is sized from
        // nothing — and the loop walks off every page the guard proved.
        let region = lift_slice(0x1000, &[
            0x8b, 0x11, 0x83, 0xc1, 0x04, 0x48, 0x83, 0xc0, 0x01, 0x75, 0xf5,
        ]).expect("lifts");
        assert!(Scope::of(&region).is_none());

        // Without the second write the same shape is accepted, so the refusal is about that
        // write and not about the shape.
        let plain = lift_slice(0x1000, &[0x8b, 0x11, 0x83, 0xc1, 0x04, 0x48, 0x75, 0xf8])
            .expect("lifts");
        assert!(Scope::of(&plain).is_some());
    }

    #[test]
    fn a_region_without_a_bounded_loop_has_no_scope() {
        // Straight-line code: nothing to prove once for, so the pass must not invent a scope.
        let region = lift_slice(0x1000, &[0x33, 0xc1, 0xc3]).expect("lifts");
        assert!(Scope::of(&region).is_none());
    }

    #[test]
    fn a_loop_whose_pointer_moves_backwards_is_declined() {
        // The guard sizes ranges forwards from the first access. A negative stride means the loop
        // reaches BELOW that address, so proving the forward extent would prove the wrong pages.
        let mut region = k3_loop();
        for instruction in &mut region.instructions {
            if let Opcode::Add32Immediate { value, .. } = &mut instruction.opcode {
                *value = -4;
            }
        }
        assert!(Scope::of(&region).is_none());
    }

    #[test]
    fn the_scoped_lowering_keeps_a_guarded_copy_and_only_it_is_entered() {
        let region = k3_loop();
        let passes = Passes { flag_liveness: true, scoped_memory: true, ..Passes::default() };
        let plain = lower_region_with(&region, false, 100_003, Passes {
            flag_liveness: true, ..Passes::default()
        }).expect("lowers");
        let scoped = lower_region_with(&region, false, 100_003, passes).expect("lowers");
        // Two copies of the loop plus a guard: bigger code buying fewer checks.
        assert!(scoped.unit.bytes.len() > plain.unit.bytes.len());
        // The published entries are unchanged — the guard took the loop head own index, which is
        // what keeps every entry value below the entry count (contract B6).
        assert_eq!(scoped.entries, plain.entries);
        assert!(scoped.entries.iter().all(|(_, index)| (*index as usize) < scoped.entries.len()));
    }

    #[test]
    fn every_block_head_is_declared_as_an_entry() {
        // The unit owns its guest page. An engine dispatch to a block head the unit does not
        // claim makes the engine compile the page and free the owning module, so the unit stops
        // running while the manifest still says it was published — a state a short run cannot
        // distinguish from a healthy one.
        let region = lift_k8(0x0064_a71f, &K8_BYTES).unwrap();
        let lowered = lower_region(&region, false).expect("k8 lowers");
        assert!(lowered.entries.len() > 1, "a region with a back edge has several heads");
        // Index i is dispatcher case i, in order, and the first entry is the region's own.
        assert_eq!(lowered.entries[0].0, region.entry_eip);
        for (i, (_, index)) in lowered.entries.iter().enumerate() {
            assert_eq!(*index, i as u32);
        }
        // Every head is a real instruction address, and they are distinct: a duplicate offset
        // would give the engine two answers for one dispatch address.
        let addresses: std::collections::BTreeSet<u32> =
            lowered.entries.iter().map(|(eip, _)| *eip).collect();
        assert_eq!(addresses.len(), lowered.entries.len());
        for (eip, _) in &lowered.entries {
            assert!(region.instructions.iter().any(|i| i.guest_eip == *eip));
        }
    }

    #[test]
    fn the_lowering_refuses_a_region_with_more_blocks_than_it_nests() {
        // A bound that refuses is the point: silently emitting unbounded nesting is how an
        // emitter produces a module nothing can read and nobody meant.
        let mut region = lift_k3(0x0010_3000, &K3_BYTES).unwrap();
        let template = region.instructions[0].clone();
        for i in 0..40 {
            let mut copy = template.clone();
            copy.guest_eip = 0x0020_0000 + i * 2;
            copy.state_in = 100 + i;
            copy.state_out = 101 + i;
            copy.effect_in = 2;
            copy.effect_out = 2;
            region.instructions.push(copy);
        }
        assert!(matches!(
            lower_region(&region, false),
            Err(LowerError::UnsupportedShape(_))
        ));
    }

    #[test]
    fn an_exit_crediting_no_instructions_is_refused() {
        // A zero delta is not a slow path: the engine loops forever on it (contract N30).
        let mut region = lift_k3(0x0010_3000, &K3_BYTES).unwrap();
        if let Opcode::BranchIf { taken: Continuation::Exit(t), .. } =
            &mut region.instructions[6].opcode
        {
            t.accounting_delta = AccountingDelta::Fixed(0);
        }
        assert!(matches!(
            lower_region(&region, false),
            Err(LowerError::UnsupportedShape(_))
        ));
    }

    #[test]
    fn a_branch_may_leave_the_region_but_not_land_mid_instruction() {
        // A computed target outside the extent is legitimate: refusing it would make any kernel
        // with a branch out of its extracted body unliftable.
        let mut region = k3();
        if let Opcode::BranchIf { taken: Continuation::Exit(taken), .. } =
            &mut region.instructions[6].opcode
        {
            taken.continuation_eip = 0x0020_0000;
        }
        assert_eq!(verify(&region), Ok(()));

        // A target INSIDE the extent that is not an instruction boundary is not: it would mean
        // the guest decodes these bytes differently than the lifter did.
        let mut region = k3();
        let mid = region.instructions[3].guest_eip + 1;
        if let Opcode::BranchIf { taken: Continuation::Exit(taken), .. } =
            &mut region.instructions[6].opcode
        {
            taken.continuation_eip = mid;
        }
        assert!(matches!(
            verify(&region),
            Err(VerifyError::ExitContinuationMismatch { at: 6, .. })
        ));
    }

    #[test]
    fn an_unsupported_boundary_must_continue_at_the_instruction_it_declined() {
        // Continuing one byte later would mean the baseline never executes it.
        let mut region = k8_with_a_boundary_return();
        first_statepoint_mut(&mut region).continuation_eip = 0xdead_beef;
        assert!(matches!(
            verify(&region),
            Err(VerifyError::ExitContinuationMismatch { .. })
        ));
    }

    #[test]
    fn an_unreachable_instruction_is_refused() {
        // k3 ends in a branch whose edges both leave, so anything appended after it is stranded.
        // The orphan must itself be a terminator, or the region fails the "ends in a terminator"
        // rule first and the reachability rule is never reached.
        let mut region = k3();
        let branch_eip = region.instructions[6].guest_eip;
        let reconstruction = match &region.instructions[6].opcode {
            Opcode::BranchIf { taken: Continuation::Exit(point), .. } => point.reconstruction,
            other => panic!("k3 ends in a branch, got {other:?}"),
        };
        region.instructions.push(Instruction {
            guest_eip: branch_eip + 2,
            state_in: 7,
            state_out: 8,
            effect_in: 2,
            effect_out: 2,
            opcode: Opcode::Exit(Statepoint {
                continuation_eip: branch_eip + 2,
                accounting_delta: AccountingDelta::Fixed(8),
                reason: ExitReason::UnsupportedInstruction,
                reconstruction,
            }),
        });
        assert_eq!(verify(&region), Err(VerifyError::UnreachableInstruction { at: 7 }));
    }

    #[test]
    fn a_looping_region_may_not_declare_a_constant_instruction_count() {
        let mut region = k8_with_a_boundary_return();
        first_statepoint_mut(&mut region).accounting_delta = AccountingDelta::Fixed(489);
        assert!(matches!(
            verify(&region),
            Err(VerifyError::FixedAccountingInALoop { .. })
        ));
    }

    #[test]
    fn a_declared_constant_delta_is_checked_against_the_path_that_reached_it() {
        let region = lift_k3(0x0010_3000, &K3_BYTES).unwrap();

        // A constant nobody executed must be refused, not credited to the guest.
        let mut wrong = region.clone();
        if let Opcode::BranchIf {
            taken: Continuation::Exit(t),
            fallthrough: Continuation::Exit(f),
            ..
        } = &mut wrong.instructions[6].opcode
        {
            t.accounting_delta = AccountingDelta::Fixed(99);
            f.accounting_delta = AccountingDelta::Fixed(99);
        }
        let (mut machine, mut memory) = k3_machine();
        assert!(matches!(
            execute(&wrong, &mut machine, &mut memory),
            ExecuteExit::AccountingMismatch { declared: 99, retired: 7, .. }
        ));

        // ...and the shipped constant agrees with the dynamic count, so the two are not two
        // errors cancelling: swapping Fixed(7) for Retired must give the same answer.
        let (mut machine, mut memory) = k3_machine();
        let with_constant = match execute(&region, &mut machine, &mut memory) {
            ExecuteExit::Statepoint { .. } => machine.accounting,
            other => panic!("unexpected {other:?}"),
        };
        let mut dynamic = region.clone();
        if let Opcode::BranchIf {
            taken: Continuation::Exit(t),
            fallthrough: Continuation::Exit(f),
            ..
        } = &mut dynamic.instructions[6].opcode
        {
            t.accounting_delta = AccountingDelta::Retired;
            f.accounting_delta = AccountingDelta::Retired;
        }
        let (mut machine, mut memory) = k3_machine();
        match execute(&dynamic, &mut machine, &mut memory) {
            ExecuteExit::Statepoint { .. } => {
                assert_eq!(machine.accounting, with_constant);
                assert_eq!(machine.accounting, 7);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_runaway_region_hits_its_budget_instead_of_hanging() {
        let mut region = lift_k8(0x0064_a71f, &K8_BYTES).unwrap();
        // Make the loop test always continue, so nothing ever leaves.
        let target = match &region.instructions[9].opcode {
            Opcode::BranchIf { fallthrough, .. } => *fallthrough,
            other => panic!("instruction 9 is the loop test, got {other:?}"),
        };
        if let Opcode::BranchIf { taken, .. } = &mut region.instructions[9].opcode {
            *taken = target;
        }
        let (mut machine, mut memory) = k8_machine();
        assert!(matches!(
            execute_with_budget(&region, &mut machine, &mut memory, 5_000),
            ExecuteExit::BudgetExhausted { retired: 5_000, .. }
        ));
    }

    #[test]
    fn an_explicit_segment_is_refused_rather_than_silently_dropped() {
        let mut region = k3();
        if let Opcode::CompareMem32Reg { address, .. } = &mut region.instructions[1].opcode {
            address.segment = Segment::Explicit { selector: 0x23, base: 0x40, limit: 0xffff };
        }
        assert!(matches!(verify(&region), Err(VerifyError::UnsupportedSegment { at: 1 })));
    }

    #[test]
    fn a_live_gpr_naming_another_register_is_a_permutation_and_is_refused() {
        let mut region = k8_with_a_boundary_return();
        first_statepoint_mut(&mut region).reconstruction.gprs[0] = ValueRef::LiveGpr(Gpr::Ecx);
        assert!(matches!(
            verify(&region),
            Err(VerifyError::LiveGprIsNotIdentity { slot: 0, .. })
        ));
    }

    #[test]
    fn shl_flags_follow_the_architecture_including_the_one_bit_overflow_case() {
        let zero = Flags::default();
        // OF is defined only for a count of one, as MSB(result) XOR CF.
        let f = flags_for_shl(0x4000_0000, 1, 0x8000_0000, zero);
        assert!(!f.cf && f.of, "no carry out, sign changed");
        let f = flags_for_shl(0x8000_0000, 1, 0, zero);
        assert!(f.cf && f.of && f.zf, "carry out, sign changed, result zero");
        let f = flags_for_shl(0xc000_0000, 1, 0x8000_0000, zero);
        assert!(f.cf && !f.of, "carry out, sign unchanged");
        // For any other count OF is undefined and left as it was.
        let previous = Flags { of: true, ..Flags::default() };
        assert!(flags_for_shl(1, 16, 1 << 16, previous).of);
        // CF is the last bit shifted out.
        assert!(flags_for_shl(0x0001_0000, 16, 0, zero).cf);
        assert!(!flags_for_shl(0x0000_8000, 16, 0x8000_0000, zero).cf);
        // The count is masked to five bits, so 32 shifts by zero and touches nothing.
        assert_eq!(flags_for_shl(0x1234_5678, 32, 0x1234_5678, previous), previous);
    }

    #[test]
    fn rejects_exit_reconstruction_with_the_wrong_effect_frontier() {
        let mut region = k3();
        if let Opcode::BranchIf { fallthrough: Continuation::Exit(fallthrough), .. } =
            &mut region.instructions[6].opcode
        {
            fallthrough.reconstruction.effect_token = 1;
        }
        assert!(matches!(
            verify(&region),
            Err(VerifyError::ReconstructionEffectMismatch { at: 6, .. })
        ));
    }

    #[test]
    fn rejects_exit_reconstruction_from_a_future_instruction() {
        let mut region = k3();
        if let Opcode::BranchIf { taken: Continuation::Exit(taken), .. } =
            &mut region.instructions[6].opcode
        {
            taken.reconstruction.flags = FlagRecipe::Arithmetic {
                instruction: 6,
                operation: FlagOperation::Decrement32,
                lhs: ValueRef::InputGpr(Gpr::Eax),
                rhs: ValueRef::Constant(1),
                result: ValueRef::InstructionResult { instruction: 5 },
                defined: FLAGS_DEC_DEFINED,
                preserved: FLAG_CF,
                preserved_from: Some(PreservedFlags {
                    instruction: 4,
                    mask: FLAG_CF,
                }),
            };
        }
        assert!(matches!(
            verify(&region),
            Err(VerifyError::InvalidFlagRecipe { at: 6, .. })
        ));
    }

    #[test]
    fn lifts_the_byte_exact_retail_k3_body() {
        let region = lift_k3(0x005d_4f87, &K3_BYTES).unwrap();
        assert_eq!(region.code_dependencies[0].body_sha256, K3_SHA256);
        assert!(matches!(
            region.instructions[1].opcode,
            Opcode::CompareMem32Reg {
                address: Address {
                    base: Some(Gpr::Ecx),
                    index: Some(Gpr::Edi),
                    ..
                },
                rhs: Gpr::Edx
            }
        ));
        assert!(matches!(
            region.instructions[2].opcode,
            Opcode::SetCondition8 {
                dst: Gpr::Edx,
                part: RegisterPart::Low8,
                condition: Condition::NotEqual
            }
        ));
    }

    #[test]
    fn refuses_to_attach_the_retail_dependency_to_changed_bytes() {
        let mut changed = K3_BYTES;
        changed[0] ^= 1;
        assert_eq!(lift_k3(0x005d_4f87, &changed), Err(LiftError::BodyMismatch));
    }

    #[test]
    fn interprets_nonzero_and_zero_sources_with_taken_and_fallthrough_exits() {
        let entry = 0x005d_4f87;
        let region = lift_k3(entry, &K3_BYTES).unwrap();
        let mut memory = Memory::new(0x400);
        let mut machine = Machine::new(entry);
        machine.set(Gpr::Ecx, 0x100);
        machine.set(Gpr::Edi, 0x80);
        machine.set(Gpr::Eax, 2);
        memory.write_u32(0x180, 0xdead_beef).unwrap();
        assert_eq!(
            execute(&region, &mut machine, &mut memory),
            ExecuteExit::Statepoint {
                reason: ExitReason::BranchTaken,
                continuation_eip: entry
            }
        );
        assert_eq!(memory.read_u32(0x100).unwrap(), 1);
        assert_eq!(machine.get(Gpr::Edx), 1);
        assert_eq!(machine.get(Gpr::Ecx), 0x104);
        assert_eq!(machine.accounting, 7);
        // Feed the next source through the reconstructed cursor and take the final fallthrough.
        memory.write_u32(0x184, 0).unwrap();
        assert_eq!(
            execute(&region, &mut machine, &mut memory),
            ExecuteExit::Statepoint {
                reason: ExitReason::Fallthrough,
                continuation_eip: entry + 16
            }
        );
        assert_eq!(memory.read_u32(0x104).unwrap(), 0);
        assert_eq!(machine.get(Gpr::Edx), 0);
        assert_eq!(machine.get(Gpr::Eax), 0);
        assert_eq!(machine.accounting, 14);
    }

    #[test]
    fn faulting_source_read_precedes_and_prevents_following_store() {
        let entry = 0x005d_4f87;
        let region = lift_k3(entry, &K3_BYTES).unwrap();
        let mut memory = Memory::new(0x400);
        let mut machine = Machine::new(entry);
        machine.set(Gpr::Ecx, 0x100);
        machine.set(Gpr::Edi, 0x80);
        machine.set(Gpr::Eax, 1);
        memory.write_u32(0x100, 0xcafe_babe).unwrap();
        let _ = memory.set_permissions(0x180, 4, false, true);
        assert!(matches!(
            execute(&region, &mut machine, &mut memory),
            ExecuteExit::Fault {
                fault: MemoryFault::Permission { address: 0x180, write: false },
                guest_eip,
                retired_instructions: 1,
                effect_token: 0,
            } if guest_eip == entry + 2
        ));
        assert_eq!(machine.eip, entry + 2);
        assert_eq!(memory.read_u32(0x100).unwrap(), 0xcafe_babe);
        assert_eq!(machine.effects, 0);
        // One instruction completed (the xor) plus the faulting load, which v86's counter
        // includes because it increments before executing. The completed count is reported
        // separately as `retired_instructions` on the exit.
        assert_eq!(machine.accounting, 2);
    }

    #[test]
    fn faulting_destination_store_keeps_the_prior_read_effect_only() {
        let entry = 0x005d_4f87;
        let region = lift_k3(entry, &K3_BYTES).unwrap();
        let mut memory = Memory::new(0x400);
        let mut machine = Machine::new(entry);
        machine.set(Gpr::Ecx, 0x100);
        machine.set(Gpr::Edi, 0x80);
        machine.set(Gpr::Eax, 1);
        memory.write_u32(0x180, 0x1234).unwrap();
        memory.write_u32(0x100, 0xcafe_babe).unwrap();
        let _ = memory.set_permissions(0x100, 4, true, false);
        assert!(matches!(
            execute(&region, &mut machine, &mut memory),
            ExecuteExit::Fault {
                fault: MemoryFault::Permission { address: 0x100, write: true },
                guest_eip,
                retired_instructions: 3,
                effect_token: 1,
            } if guest_eip == entry + 8
        ));
        assert_eq!(memory.read_u32(0x100).unwrap(), 0xcafe_babe);
        assert_eq!(machine.effects, 1);
        // The ENGINE counter includes the faulting access (v86 increments before executing); the
        // logical-work ledger, reported as `retired_instructions` on the exit, does not.
        assert_eq!(machine.accounting, 4);
    }

    #[test]
    fn setne_dl_merges_only_the_low_byte() {
        let entry = 0x005d_4f87;
        let mut region = lift_k3(entry, &K3_BYTES).unwrap();
        // Keep EDX's upper bytes live to exercise the architectural partial-register rule.
        region.instructions[0].opcode = Opcode::Xor32 {
            dst: Gpr::Eax,
            src: Gpr::Eax,
        };
        let mut memory = Memory::new(0x400);
        let mut machine = Machine::new(entry);
        machine.set(Gpr::Ecx, 0x100);
        machine.set(Gpr::Edi, 0x80);
        machine.set(Gpr::Eax, 1);
        machine.set(Gpr::Edx, 0xaabb_ccdd);
        memory.write_u32(0x180, 0xaabb_ccdd).unwrap();
        execute(&region, &mut machine, &mut memory);
        assert_eq!(machine.get(Gpr::Edx), 0xaabb_cc00);
        assert_eq!(memory.read_u32(0x100).unwrap(), 0xaabb_cc00);
    }

    #[test]
    fn rejects_reconstruction_of_a_non_value_effect_instruction() {
        let mut region = lift_k3(0x005d_4f87, &K3_BYTES).unwrap();
        if let Opcode::BranchIf { taken: Continuation::Exit(taken), .. } =
            &mut region.instructions[6].opcode
        {
            taken.reconstruction.gprs[2] = ValueRef::InstructionResult { instruction: 1 };
        }
        assert!(matches!(
            verify(&region),
            Err(VerifyError::NonValueInstructionResult {
                at: 6,
                value_instruction: 1
            })
        ));
    }

    #[test]
    fn arithmetic_flag_calculation_covers_overflow_sign_parity_and_auxiliary_carry() {
        let positive_overflow = flags_for_add(0x7fff_ffff, 1, 0x8000_0000);
        assert!(!positive_overflow.cf);
        assert!(positive_overflow.of && positive_overflow.sf && positive_overflow.af);
        assert!(positive_overflow.pf); // low byte is zero: even parity

        let carry = flags_for_add(0xffff_ffff, 1, 0);
        assert!(carry.cf && carry.zf && carry.af && carry.pf);
        assert!(!carry.of && !carry.sf);

        let subtract_overflow = flags_for_sub(0x8000_0000, 1, 0x7fff_ffff);
        assert!(!subtract_overflow.cf);
        assert!(subtract_overflow.of && subtract_overflow.af && subtract_overflow.pf);
        assert!(!subtract_overflow.sf && !subtract_overflow.zf);

        let xor = flags_for_logic(0x8000_0001);
        assert!(!xor.cf && !xor.of && xor.sf && !xor.pf && !xor.zf);
    }

    #[test]
    fn decrement_preserves_incoming_carry_and_computes_its_other_flags() {
        let old_flags = Flags {
            cf: true,
            ..Flags::default()
        };
        let flags = flags_for_dec(0x8000_0000, old_flags);
        assert!(flags.cf); // DEC must not modify CF.
        assert!(flags.of && flags.af && flags.pf);
        assert!(!flags.sf && !flags.zf);
    }

    #[test]
    fn canonical_exit_applies_the_explicit_materialized_flag_recipe() {
        let entry = 0x005d_4f87;
        let mut region = lift_k3(entry, &K3_BYTES).unwrap();
        let expected = Flags {
            cf: true,
            pf: true,
            af: true,
            zf: false,
            sf: true,
            of: true,
        };
        if let Opcode::BranchIf { taken: Continuation::Exit(taken), .. } =
            &mut region.instructions[6].opcode
        {
            taken.reconstruction.flags = FlagRecipe::Materialized(expected);
        }
        let mut memory = Memory::new(0x400);
        memory.write_u32(0x180, 1).unwrap();
        let mut machine = Machine::new(entry);
        machine.set(Gpr::Ecx, 0x100);
        machine.set(Gpr::Edi, 0x80);
        machine.set(Gpr::Eax, 2);
        execute(&region, &mut machine, &mut memory);
        assert_eq!(machine.flags, expected);
    }

    #[test]
    fn rejects_flag_recipe_with_wrong_source_or_defined_mask() {
        let mut wrong_source = lift_k3(0x005d_4f87, &K3_BYTES).unwrap();
        if let Opcode::BranchIf { taken: Continuation::Exit(taken), .. } =
            &mut wrong_source.instructions[6].opcode
        {
            taken.reconstruction.flags = FlagRecipe::Arithmetic {
                instruction: 4,
                operation: FlagOperation::Add32,
                lhs: ValueRef::InputGpr(Gpr::Ecx),
                rhs: ValueRef::Constant(4),
                result: ValueRef::InstructionResult { instruction: 4 },
                defined: FLAGS_ARITHMETIC_DEFINED,
                preserved: 0,
                preserved_from: None,
            };
        }
        assert!(matches!(
            verify(&wrong_source),
            Err(VerifyError::InvalidFlagRecipe { at: 6, .. })
        ));

        let mut wrong_mask = lift_k3(0x005d_4f87, &K3_BYTES).unwrap();
        if let Opcode::BranchIf { taken: Continuation::Exit(taken), .. } =
            &mut wrong_mask.instructions[6].opcode
        {
            taken.reconstruction.flags = FlagRecipe::Arithmetic {
                instruction: 5,
                operation: FlagOperation::Decrement32,
                lhs: ValueRef::InputGpr(Gpr::Eax),
                rhs: ValueRef::Constant(1),
                result: ValueRef::InstructionResult { instruction: 5 },
                defined: FLAGS_ARITHMETIC_DEFINED,
                preserved: 0,
                preserved_from: None,
            };
        }
        assert!(matches!(
            verify(&wrong_mask),
            Err(VerifyError::InvalidFlagRecipe { at: 6, .. })
        ));
    }

    #[test]
    fn rejects_dec_recipe_with_wrong_preserved_source_or_ssa_operands() {
        let mut wrong_preserved_source = lift_k3(0x005d_4f87, &K3_BYTES).unwrap();
        if let Opcode::BranchIf { taken: Continuation::Exit(taken), .. } =
            &mut wrong_preserved_source.instructions[6].opcode
        {
            if let FlagRecipe::Arithmetic { preserved_from, .. } = &mut taken.reconstruction.flags {
                *preserved_from = Some(PreservedFlags {
                    instruction: 1,
                    mask: FLAG_CF,
                });
            }
        }
        assert!(matches!(
            verify(&wrong_preserved_source),
            Err(VerifyError::InvalidFlagRecipe { at: 6, .. })
        ));

        let mut wrong_operands = lift_k3(0x005d_4f87, &K3_BYTES).unwrap();
        if let Opcode::BranchIf { taken: Continuation::Exit(taken), .. } =
            &mut wrong_operands.instructions[6].opcode
        {
            if let FlagRecipe::Arithmetic { lhs, result, .. } = &mut taken.reconstruction.flags {
                *lhs = ValueRef::InstructionResult { instruction: 4 };
                *result = ValueRef::InstructionResult { instruction: 4 };
            }
        }
        assert!(matches!(
            verify(&wrong_operands),
            Err(VerifyError::InvalidFlagRecipe { at: 6, .. })
        ));
    }
}
