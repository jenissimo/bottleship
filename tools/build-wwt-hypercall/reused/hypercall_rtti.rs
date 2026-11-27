//! MSVC C++ RTTI — __RTDynamicCast (dynamic_cast runtime), the hypercall hot path.
//! Mirrors src/worker/modules/crt-rtti.ts: implemented from the publicly documented
//! 32-bit MSVC RTTI metadata layout (CompleteObjectLocator at vftable[-1] →
//! ClassHierarchyDescriptor → pre-order BaseClassArray with PMD displacements) and
//! standard dynamic_cast semantics.

use super::Guest;

const BCD_NOTVISIBLE: u32 = 0x0000_0002;
const BCD_AMBIGUOUS: u32 = 0x0000_0004;
const CHD_MULTINH: u32 = 0x0000_0001;
const CHD_VIRTINH: u32 = 0x0000_0002;

/// BaseClassDescriptor (24-byte VC6-era layout — never require the trailing pCHD).
#[derive(Copy, Clone)]
struct BaseClassEntry {
    type_desc_ptr: u32,
    num_contained_bases: u32,
    // PMD: member disp / vbtable-ptr disp (-1 = non-virtual) / vbtable slot disp.
    mdisp: i32,
    pdisp: i32,
    vdisp: i32,
    attributes: u32,
}

struct Hierarchy {
    attributes: u32,
    base_class_array_ptr: u32,
    n_bases: u32,
}

enum DownCast {
    Found(BaseClassEntry),
    Ambiguous,
    Miss,
}

pub enum RtDynamicCastResult {
    Success(u32),
    FailNull,
    FailBadCast,
}

// TypeDescriptors are compared by decorated name, not address: each module links
// its own copy of a shared type's descriptor.
unsafe fn same_type(guest: Guest, lhs_ptr: u32, rhs_ptr: u32) -> bool {
    if lhs_ptr == 0 || rhs_ptr == 0 {
        return false;
    }
    if lhs_ptr == rhs_ptr {
        return true;
    }
    let mut saw_non_nul = false;
    for i in 0..256u32 {
        let c1 = match guest.unit(lhs_ptr + 8 + i, 1) {
            Some(v) => v,
            None => return false,
        };
        let c2 = match guest.unit(rhs_ptr + 8 + i, 1) {
            Some(v) => v,
            None => return false,
        };
        if c1 != c2 {
            return false;
        }
        if c1 == 0 {
            return saw_non_nul;
        }
        saw_non_nul = true;
    }
    false
}

unsafe fn read_base_class_entry(
    guest: Guest,
    array_ptr: u32,
    index: u32,
) -> Option<BaseClassEntry> {
    if array_ptr < 0x1000 {
        return None;
    }
    let ptr = guest.read32(array_ptr + index * 4)?;
    if ptr < 0x1000 {
        return None;
    }
    Some(BaseClassEntry {
        type_desc_ptr: guest.read32(ptr)?,
        num_contained_bases: guest.read32(ptr + 4)?,
        mdisp: guest.read32(ptr + 8).map(|v| v as i32)?,
        pdisp: guest.read32(ptr + 12).map(|v| v as i32)?,
        vdisp: guest.read32(ptr + 16).map(|v| v as i32)?,
        attributes: guest.read32(ptr + 20)?,
    })
}

unsafe fn get_complete_object_locator(guest: Guest, inptr: u32) -> Option<u32> {
    if inptr < 4 {
        return None;
    }
    let vfptr = guest.read32(inptr)?;
    if vfptr < 8 {
        return None;
    }
    guest.read32(vfptr - 4)
}

/// Walk locator.offset back, then the vtordisp at [inptr - cdOffset] when present.
/// The low-pointer guard keeps a corrupt vtable with a COL pointer in (0, 0x1000)
/// failing deterministically instead of walking low guest memory as if it were RTTI.
unsafe fn locate_complete_object(guest: Guest, inptr: u32, locator_ptr: u32) -> Option<u32> {
    if locator_ptr < 0x1000 {
        return None;
    }
    let offset = guest.read32(locator_ptr + 4)?;
    let cd_offset = guest.read32(locator_ptr + 8)?;

    let vtordisp = if cd_offset > 0 && inptr >= cd_offset {
        guest
            .read32(inptr - cd_offset)
            .map(|v| v as i32)
            .unwrap_or(0)
    } else {
        0
    };
    Some(inptr.wrapping_sub(offset).wrapping_sub(vtordisp as u32))
}

/// A base class entry's subobject offset within the complete object (resolving the PMD).
unsafe fn subobject_offset(guest: Guest, complete_object: u32, entry: &BaseClassEntry) -> i32 {
    let mut off = entry.mdisp;
    if entry.pdisp >= 0 {
        // Virtual base: indirect through the vbtable the pdisp points at.
        let vb_ptr_addr = complete_object.wrapping_add(entry.pdisp as u32);
        let vb_table = match guest.read32(vb_ptr_addr) {
            Some(v) => v,
            None => return 0,
        };
        let slot_addr = vb_table.wrapping_add(entry.vdisp as u32);
        let slot = match guest.read32(slot_addr).map(|v| v as i32) {
            Some(v) => v,
            None => return 0,
        };
        off += entry.pdisp + slot;
    }
    off
}

unsafe fn read_hierarchy(guest: Guest, locator_ptr: u32) -> Option<Hierarchy> {
    let chd_ptr = guest.read32(locator_ptr + 16)?;
    if chd_ptr < 0x1000 {
        return None;
    }
    let attributes = guest.read32(chd_ptr + 4)?;
    let n_bases = guest.read32(chd_ptr + 8)?;
    let base_class_array_ptr = guest.read32(chd_ptr + 12)?;
    if base_class_array_ptr == 0 || n_bases == 0 || n_bases > 0xffff {
        return None;
    }
    Some(Hierarchy {
        attributes,
        base_class_array_ptr,
        n_bases,
    })
}

/// Down-cast resolution. The BaseClassArray is a pre-order flattening: entry i's
/// subtree is the num_contained_bases entries following it. A target-type entry
/// qualifies when the source subobject (matched by type AND by its offset within
/// the complete object) is in that subtree. With virtual inheritance one virtual
/// base can be reachable from several target instances — that is only unambiguous
/// if all qualifying instances resolve to the SAME subobject offset.
unsafe fn resolve_down_cast(
    guest: Guest,
    complete_object: u32,
    hier: &Hierarchy,
    src_type_ptr: u32,
    src_offset: i32,
    target_type_ptr: u32,
) -> DownCast {
    let virtual_inh = (hier.attributes & CHD_VIRTINH) != 0;
    let mut found: Option<BaseClassEntry> = None;

    for i in 0..hier.n_bases {
        let candidate = match read_base_class_entry(guest, hier.base_class_array_ptr, i) {
            Some(v) => v,
            None => continue,
        };
        if !same_type(guest, candidate.type_desc_ptr, target_type_ptr) {
            continue;
        }

        let subtree_end = (i + 1 + candidate.num_contained_bases).min(hier.n_bases);
        for j in (i + 1)..subtree_end {
            let sub = match read_base_class_entry(guest, hier.base_class_array_ptr, j) {
                Some(v) => v,
                None => continue,
            };
            if !same_type(guest, sub.type_desc_ptr, src_type_ptr) {
                continue;
            }
            if subobject_offset(guest, complete_object, &sub) != src_offset {
                continue;
            }

            if !virtual_inh {
                return DownCast::Found(candidate);
            }
            if let Some(prev) = found {
                if subobject_offset(guest, complete_object, &prev)
                    != subobject_offset(guest, complete_object, &candidate)
                {
                    return DownCast::Ambiguous;
                }
            }
            found = Some(candidate);
            break;
        }
    }
    match found {
        Some(entry) => DownCast::Found(entry),
        None => DownCast::Miss,
    }
}

/// Cross-cast: any visible, unambiguous instance of the target type qualifies.
unsafe fn resolve_cross_cast(
    guest: Guest,
    hier: &Hierarchy,
    target_type_ptr: u32,
) -> Option<BaseClassEntry> {
    for i in 0..hier.n_bases {
        let entry = match read_base_class_entry(guest, hier.base_class_array_ptr, i) {
            Some(v) => v,
            None => continue,
        };
        if same_type(guest, entry.type_desc_ptr, target_type_ptr)
            && (entry.attributes & (BCD_NOTVISIBLE | BCD_AMBIGUOUS)) == 0
        {
            return Some(entry);
        }
    }
    None
}

pub(super) unsafe fn rt_dynamic_cast(
    guest: Guest,
    inptr: u32,
    vf_delta: i32,
    src_type_ptr: u32,
    target_type_ptr: u32,
    is_reference: i32,
) -> RtDynamicCastResult {
    if inptr == 0 {
        return RtDynamicCastResult::FailNull;
    }

    let locator_ptr = match get_complete_object_locator(guest, inptr) {
        Some(v) => v,
        None => return fail_cast(is_reference, inptr),
    };
    let complete_object = match locate_complete_object(guest, inptr, locator_ptr) {
        Some(v) => v,
        None => return fail_cast(is_reference, inptr),
    };
    let hier = match read_hierarchy(guest, locator_ptr) {
        Some(v) => v,
        None => return fail_cast(is_reference, inptr),
    };

    let target = if (hier.attributes & CHD_MULTINH) == 0 {
        // Single inheritance: the hierarchy is a linear chain, so any visible
        // instance of the target type is THE instance — the source type and
        // subobject offset are irrelevant.
        let mut found: Option<BaseClassEntry> = None;
        for i in 0..hier.n_bases {
            let entry = match read_base_class_entry(guest, hier.base_class_array_ptr, i) {
                Some(v) => v,
                None => continue,
            };
            if same_type(guest, entry.type_desc_ptr, target_type_ptr)
                && (entry.attributes & BCD_NOTVISIBLE) == 0
            {
                found = Some(entry);
                break;
            }
        }
        found
    } else {
        // inptr points at the vfptr the compiler dereferenced; vf_delta is that
        // vfptr's offset within the source subobject. Undo it: the subobject's
        // delta from the complete object identifies WHICH instance of the
        // source type we are casting from.
        let src_offset = inptr
            .wrapping_sub(vf_delta as u32)
            .wrapping_sub(complete_object) as i32;
        match resolve_down_cast(
            guest,
            complete_object,
            &hier,
            src_type_ptr,
            src_offset,
            target_type_ptr,
        ) {
            DownCast::Found(entry) => Some(entry),
            // A virtual-inheritance ambiguity is a hard failure; only a plain
            // miss falls through to the cross-cast rule.
            DownCast::Ambiguous => None,
            DownCast::Miss => resolve_cross_cast(guest, &hier, target_type_ptr),
        }
    };

    match target {
        Some(entry) => {
            let offset = subobject_offset(guest, complete_object, &entry);
            RtDynamicCastResult::Success(complete_object.wrapping_add(offset as u32))
        }
        None => fail_cast(is_reference, inptr),
    }
}

#[inline]
fn fail_cast(is_reference: i32, inptr: u32) -> RtDynamicCastResult {
    if is_reference != 0 && inptr != 0 {
        RtDynamicCastResult::FailBadCast
    } else {
        RtDynamicCastResult::FailNull
    }
}
