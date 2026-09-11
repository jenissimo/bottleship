//! A minimal Wasm encoder, shaped by the module contract an AOT unit must satisfy.
//!
//! This is not a general Wasm library. It emits exactly the module shape `plan/aot-module-contract.md`
//! §1–§2 pins down — one exported function `"f"` of type `(i32) -> ()`, imports from module `"e"`
//! only, the memory import `e.m` with 64 pages — because a unit that is merely *valid* Wasm and not
//! that shape is rejected at instantiation or, worse, entered and mis-dispatched.
//!
//! The contract's numbering is cited where a choice is not free.

/// Wasm value types.
pub const T_I32: u8 = 0x7f;
const T_FUNC: u8 = 0x60;
const BLOCK_VOID: u8 = 0x40;

/// The opcodes this lowering emits. Deliberately not the full set: an opcode that is never
/// emitted is one whose encoding cannot be silently wrong.
pub mod op {
    pub const BLOCK: u8 = 0x02;
    pub const LOOP: u8 = 0x03;
    pub const IF: u8 = 0x04;
    pub const ELSE: u8 = 0x05;
    pub const END: u8 = 0x0b;
    pub const BR: u8 = 0x0c;
    pub const BR_IF: u8 = 0x0d;
    pub const BR_TABLE: u8 = 0x0e;
    pub const RETURN: u8 = 0x0f;
    pub const CALL: u8 = 0x10;
    pub const DROP: u8 = 0x1a;
    pub const LOCAL_GET: u8 = 0x20;
    pub const LOCAL_SET: u8 = 0x21;
    pub const LOCAL_TEE: u8 = 0x22;
    pub const I32_LOAD: u8 = 0x28;
    pub const I32_LOAD8_U: u8 = 0x2d;
    pub const I32_STORE: u8 = 0x36;
    pub const I32_CONST: u8 = 0x41;
    pub const I32_EQZ: u8 = 0x45;
    pub const I32_EQ: u8 = 0x46;
    pub const I32_NE: u8 = 0x47;
    pub const I32_LT_S: u8 = 0x48;
    pub const I32_LE_S: u8 = 0x4c;
    pub const I32_GE_S: u8 = 0x4e;
    pub const I32_GE_U: u8 = 0x4f;
    pub const I32_LT_U: u8 = 0x49;
    pub const I32_LE_U: u8 = 0x4d;
    pub const SELECT: u8 = 0x1b;
    pub const I32_MUL: u8 = 0x6c;
    pub const I32_POPCNT: u8 = 0x69;
    pub const I32_ADD: u8 = 0x6a;
    pub const I32_SUB: u8 = 0x6b;
    pub const I32_AND: u8 = 0x71;
    pub const I32_OR: u8 = 0x72;
    pub const I32_XOR: u8 = 0x73;
    pub const I32_SHL: u8 = 0x74;
    pub const I32_SHR_S: u8 = 0x75;
    pub const I32_SHR_U: u8 = 0x76;
}

pub fn leb_u(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// A fixed five-byte unsigned LEB, so a value patched in later cannot change the body length.
pub fn leb_u5(out: &mut Vec<u8>, value: u32) {
    let mut v = value;
    for i in 0..5 {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        out.push(if i == 4 { byte } else { byte | 0x80 });
    }
}

/// Overwrite a five-byte placeholder in place.
pub fn patch_leb_u5(bytes: &mut [u8], at: usize, value: u32) {
    let mut v = value;
    for i in 0..5 {
        bytes[at + i] = if i == 4 { (v & 0x7f) as u8 } else { ((v & 0x7f) as u8) | 0x80 };
        v >>= 7;
    }
}

pub fn leb_s(out: &mut Vec<u8>, mut value: i64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        let sign_bit_set = byte & 0x40 != 0;
        if (value == 0 && !sign_bit_set) || (value == -1 && sign_bit_set) {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// A function signature, identified by a stable key so two callers naming the same shape share
/// one type index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FuncType {
    pub key: &'static str,
    pub params: Vec<u8>,
    pub results: Vec<u8>,
}

impl FuncType {
    /// The signature of the exported entry itself: contract N1.
    pub fn entry() -> Self {
        Self { key: "i_v", params: vec![T_I32], results: vec![] }
    }

    /// Decode a helper signature written the way `tools/aot/lib/abi.mjs` writes them, e.g.
    /// `"ii_i"` for `(i32, i32) -> i32`. Sharing that spelling means the helper table is one
    /// source of truth rather than two that can disagree about an arity.
    pub fn parse(key: &'static str) -> Option<Self> {
        let (params, results) = key.split_once('_')?;
        let decode = |s: &str| -> Option<Vec<u8>> {
            s.chars()
                .filter(|c| *c != 'v')
                .map(|c| if c == 'i' { Some(T_I32) } else { None })
                .collect()
        };
        Some(Self { key, params: decode(params)?, results: decode(results)? })
    }
}

/// One imported engine helper, in first-use order (contract N7).
#[derive(Clone, Debug)]
struct Import {
    name: String,
    type_key: &'static str,
}

/// A value the loader patches in at publication, recorded as a byte offset into the function body.
///
/// The site carries a fixed-width five-byte LEB placeholder so patching cannot change the body's
/// length — a shorter encoding would move every offset after it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Relocation {
    pub kind: &'static str,
    pub at: usize,
    pub width: usize,
}

/// Builds one unit module.
pub struct ModuleBuilder {
    imports: Vec<Import>,
    types: Vec<FuncType>,
    local_types: Vec<u8>,
    body: Vec<u8>,
    /// Open labels, innermost last. `br` takes a RELATIVE depth, so a named branch is only
    /// correct if the name resolves against the stack as it stands at the branch.
    labels: Vec<&'static str>,
    relocs: Vec<Relocation>,
    /// Operand-stack depth, tracked as instructions are emitted.
    ///
    /// A Wasm validator reports an imbalance as a byte offset in a compiled module, which
    /// says nothing about which emitter left the value behind. Tracking it here turns the
    /// same mistake into a failure at the call site that made it.
    stack: i32,
    /// Depth at the point each open label was entered, so a block ending at a different
    /// depth than it started is caught rather than deferred to the validator.
    label_stack: Vec<i32>,
    /// Set after an unconditional transfer, where the stack is polymorphic and depth
    /// tracking is meaningless until the next label boundary.
    unreachable: bool,
}

impl Default for ModuleBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl ModuleBuilder {
    pub fn new() -> Self {
        Self {
            imports: Vec::new(),
            types: vec![FuncType::entry()],
            local_types: Vec::new(),
            body: Vec::new(),
            labels: Vec::new(),
            relocs: Vec::new(),
            stack: 0,
            label_stack: Vec::new(),
            unreachable: false,
        }
    }

    /// Declare (or reuse) an imported helper and return its function index.
    ///
    /// Function indices come before the exported function, which is why N2 can say the export's
    /// index equals the import count: every import is declared before the body is finished.
    pub fn import(&mut self, name: &str, type_key: &'static str) -> Result<u32, EmitError> {
        if let Some(index) = self.imports.iter().position(|i| i.name == name) {
            return Ok(index as u32);
        }
        let signature = FuncType::parse(type_key).ok_or(EmitError::BadSignature(type_key))?;
        if !self.types.iter().any(|t| t.key == signature.key) {
            self.types.push(signature);
        }
        self.imports.push(Import { name: name.to_string(), type_key });
        Ok((self.imports.len() - 1) as u32)
    }

    /// Allocate a local. Local 0 is the entry parameter (contract N5) and is NOT allocated here.
    pub fn local(&mut self, ty: u8) -> u32 {
        self.local_types.push(ty);
        self.local_types.len() as u32   // +1 for the parameter, which occupies index 0
    }

    /// Record the stack effect of an emitted opcode.
    fn effect(&mut self, pops: i32, pushes: i32) {
        if self.unreachable {
            return;
        }
        self.stack = self.stack - pops + pushes;
    }

    /// Emit a raw opcode, accounting for its stack effect. Only the opcodes this lowering uses
    /// are known; an unknown one is treated as neutral, which is why every emitter should prefer
    /// the named helpers above.
    pub fn u8(&mut self, byte: u8) -> &mut Self {
        match byte {
            op::I32_ADD | op::I32_SUB | op::I32_AND | op::I32_OR | op::I32_XOR | op::I32_SHL
            | op::I32_SHR_S | op::I32_SHR_U | op::I32_EQ | op::I32_NE | op::I32_LT_S | op::I32_LE_S | op::I32_LT_U | op::I32_LE_U | op::I32_MUL
            | op::I32_GE_S | op::I32_GE_U => self.effect(2, 1),
            op::SELECT => self.effect(3, 1),
            op::I32_EQZ | op::I32_POPCNT => self.effect(1, 1),
            op::DROP => self.effect(1, 0),
            op::RETURN => self.unreachable = true,
            op::IF => {
                // The condition is consumed here; each arm is tracked against the depth the `if`
                // was entered at.
                self.effect(1, 0);
                self.labels.push("if");
                self.label_stack.push(self.stack);
            }
            op::ELSE => {
                // Both arms start from the depth the `if` did.
                self.stack = *self.label_stack.last().unwrap_or(&0);
                self.unreachable = false;
            }
            op::END => {
                self.labels.pop();
                if let Some(depth) = self.label_stack.pop() {
                    self.stack = depth;
                }
                self.unreachable = false;
            }
            _ => {}
        }
        self.body.push(byte);
        self
    }

    /// The operand-stack depth as tracked so far.
    pub fn stack_depth(&self) -> i32 {
        self.stack
    }

    pub fn const_i32(&mut self, value: i32) -> &mut Self {
        self.effect(0, 1);
        self.body.push(op::I32_CONST);
        leb_s(&mut self.body, value as i64);
        self
    }

    pub fn local_get(&mut self, index: u32) -> &mut Self {
        self.effect(0, 1);
        self.body.push(op::LOCAL_GET);
        leb_u(&mut self.body, index as u64);
        self
    }

    pub fn local_set(&mut self, index: u32) -> &mut Self {
        self.effect(1, 0);
        self.body.push(op::LOCAL_SET);
        leb_u(&mut self.body, index as u64);
        self
    }

    pub fn local_tee(&mut self, index: u32) -> &mut Self {
        self.effect(1, 1);
        self.body.push(op::LOCAL_TEE);
        leb_u(&mut self.body, index as u64);
        self
    }

    /// `i32.load` of guest state at a fixed linear address.
    ///
    /// The address goes in the CONSTANT and the memarg offset is zero, which is the shape the
    /// reference codegen emits and the shape the unit verifier pattern-matches. Putting it in the
    /// offset immediate instead produces a module that is valid, means the same thing, and fails
    /// every structural check that identifies a prologue, a flush or a counter fold.
    pub fn load_fixed(&mut self, address: u32) -> &mut Self {
        self.const_i32(address as i32);
        self.effect(1, 1);
        self.body.push(op::I32_LOAD);
        leb_u(&mut self.body, 2);   // alignment 4
        leb_u(&mut self.body, 0);
        self
    }

    /// `i32.store` of guest state at a fixed linear address, with the value emitted by `value`.
    pub fn store_fixed(&mut self, address: u32, value: impl FnOnce(&mut Self)) -> &mut Self {
        self.const_i32(address as i32);
        value(self);
        self.effect(2, 0);
        self.body.push(op::I32_STORE);
        leb_u(&mut self.body, 2);
        leb_u(&mut self.body, 0);
        self
    }

    pub fn call(&mut self, function: u32) -> &mut Self {
        // The declared signature is the authority on how many operands a call consumes.
        let key = self.imports.get(function as usize).map(|i| i.type_key).unwrap_or("v_v");
        if let Some(signature) = FuncType::parse(key) {
            self.effect(signature.params.len() as i32, signature.results.len() as i32);
        }
        self.body.push(op::CALL);
        leb_u(&mut self.body, function as u64);
        self
    }

    pub fn block(&mut self, label: &'static str) -> &mut Self {
        self.body.push(op::BLOCK);
        self.body.push(BLOCK_VOID);
        self.labels.push(label);
        self.label_stack.push(self.stack);
        self
    }

    pub fn loop_(&mut self, label: &'static str) -> &mut Self {
        self.body.push(op::LOOP);
        self.body.push(BLOCK_VOID);
        self.labels.push(label);
        self.label_stack.push(self.stack);
        self
    }

    /// Close the innermost label. A void block that ends at a different depth than it began
    /// is refused HERE, naming the label, rather than surfacing as a byte offset later.
    pub fn end(&mut self) -> Result<&mut Self, EmitError> {
        let label = self.labels.pop().ok_or(EmitError::UnbalancedLabels)?;
        let entered = self.label_stack.pop().unwrap_or(0);
        if !self.unreachable && self.stack != entered {
            return Err(EmitError::StackImbalance { label, entered, found: self.stack });
        }
        self.stack = entered;
        self.unreachable = false;
        self.body.push(op::END);
        Ok(self)
    }

    /// Relative depth of a named label from the current point.
    pub fn depth_of(&self, label: &str) -> Result<u32, EmitError> {
        self.labels
            .iter()
            .rposition(|l| *l == label)
            .map(|i| (self.labels.len() - 1 - i) as u32)
            .ok_or(EmitError::UnknownLabel)
    }

    pub fn br_to(&mut self, label: &str) -> Result<&mut Self, EmitError> {
        let depth = self.depth_of(label)?;
        Ok(self.br(depth))
    }

    pub fn br_if_to(&mut self, label: &str) -> Result<&mut Self, EmitError> {
        let depth = self.depth_of(label)?;
        Ok(self.br_if(depth))
    }

    /// `i32.load` whose OFFSET immediate is patched at publication.
    ///
    /// The placeholder is a five-byte LEB so the patch cannot change the body length; the
    /// relocation records where it sits, relative to the start of the instruction stream.
    pub fn load_reloc_offset(&mut self, kind: &'static str) -> &mut Self {
        self.effect(1, 1);
        self.body.push(op::I32_LOAD);
        leb_u(&mut self.body, 2);
        self.relocs.push(Relocation { kind, at: self.body.len(), width: 5 });
        leb_u5(&mut self.body, 0);
        self
    }

    pub fn br(&mut self, depth: u32) -> &mut Self {
        self.unreachable = true;
        self.body.push(op::BR);
        leb_u(&mut self.body, depth as u64);
        self
    }

    pub fn br_if(&mut self, depth: u32) -> &mut Self {
        self.effect(1, 0);
        self.body.push(op::BR_IF);
        leb_u(&mut self.body, depth as u64);
        self
    }

    /// `br_table` over `cases`, with `default`.
    pub fn br_table(&mut self, cases: &[u32], default: u32) -> &mut Self {
        self.effect(1, 0);
        self.unreachable = true;
        self.body.push(op::BR_TABLE);
        leb_u(&mut self.body, cases.len() as u64);
        for case in cases {
            leb_u(&mut self.body, *case as u64);
        }
        leb_u(&mut self.body, default as u64);
        self
    }

    pub fn body_len(&self) -> usize {
        self.body.len()
    }

    /// `i32.load` from an address already on the stack, offset zero — the trailing inline access
    /// of a safe read (contract N49).
    pub fn body_load_u32(&mut self) -> &mut Self {
        self.effect(1, 1);
        self.body.push(op::I32_LOAD);
        leb_u(&mut self.body, 0);   // alignment 1: the address is not known to be aligned
        leb_u(&mut self.body, 0);
        self
    }

    pub fn body_load_u8(&mut self) -> &mut Self {
        self.effect(1, 1);
        self.body.push(op::I32_LOAD8_U);
        leb_u(&mut self.body, 0);
        leb_u(&mut self.body, 0);
        self
    }

    /// `i32.store` with address and value already on the stack, offset zero.
    pub fn body_store_u32(&mut self) -> &mut Self {
        self.effect(2, 0);
        self.body.push(op::I32_STORE);
        leb_u(&mut self.body, 0);
        leb_u(&mut self.body, 0);
        self
    }

    pub fn relocations(&self) -> &[Relocation] {
        &self.relocs
    }

    /// Assemble the module.
    ///
    /// Section order is contract N7; the memory import's shape is N8; the single export named
    /// `"f"` at index `imports.len()` is N1/N2.
    pub fn finish(self) -> Result<Unit, EmitError> {
        if !self.labels.is_empty() {
            return Err(EmitError::UnbalancedLabels);
        }
        if !self.unreachable && self.stack != 0 {
            return Err(EmitError::StackImbalance {
                label: "<function>",
                entered: 0,
                found: self.stack,
            });
        }
        let mut out: Vec<u8> = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

        let type_index = |key: &str| -> u32 {
            self.types.iter().position(|t| t.key == key).unwrap() as u32
        };

        // type section
        {
            let mut p = Vec::new();
            leb_u(&mut p, self.types.len() as u64);
            for t in &self.types {
                p.push(T_FUNC);
                leb_u(&mut p, t.params.len() as u64);
                p.extend_from_slice(&t.params);
                leb_u(&mut p, t.results.len() as u64);
                p.extend_from_slice(&t.results);
            }
            section(&mut out, 1, &p);
        }
        // import section: helpers in first-use order, then the memory (N6, N7, N8)
        {
            let mut p = Vec::new();
            leb_u(&mut p, (self.imports.len() + 1) as u64);
            for im in &self.imports {
                leb_u(&mut p, 1);
                p.push(b'e');
                leb_u(&mut p, im.name.len() as u64);
                p.extend_from_slice(im.name.as_bytes());
                p.push(0x00);
                leb_u(&mut p, type_index(im.type_key) as u64);
            }
            leb_u(&mut p, 1);
            p.push(b'e');
            leb_u(&mut p, 1);
            p.push(b'm');
            p.push(0x02);           // memory
            p.push(0x00);           // limits: min only, NOT shared
            leb_u(&mut p, 64);      // wasm_builder.rs:595
            section(&mut out, 2, &p);
        }
        // function section
        {
            let mut p = Vec::new();
            leb_u(&mut p, 1);
            leb_u(&mut p, type_index("i_v") as u64);
            section(&mut out, 3, &p);
        }
        // export section
        {
            let mut p = Vec::new();
            leb_u(&mut p, 1);
            leb_u(&mut p, 1);
            p.push(b'f');
            p.push(0x00);
            leb_u(&mut p, self.imports.len() as u64);
            section(&mut out, 7, &p);
        }
        // code section
        let body_start;
        {
            let mut groups: Vec<(u32, u8)> = Vec::new();
            for ty in &self.local_types {
                match groups.last_mut() {
                    Some((count, last)) if last == ty => *count += 1,
                    _ => groups.push((1, *ty)),
                }
            }
            let mut fn_body = Vec::new();
            leb_u(&mut fn_body, groups.len() as u64);
            for (count, ty) in groups {
                leb_u(&mut fn_body, count as u64);
                fn_body.push(ty);
            }
            fn_body.extend_from_slice(&self.body);
            fn_body.push(op::END);

            let locals_len = fn_body.len() - self.body.len() - 1;   // groups header, minus the END

            let mut p = Vec::new();
            leb_u(&mut p, 1);
            leb_u(&mut p, fn_body.len() as u64);
            p.extend_from_slice(&fn_body);
            // Where the instruction stream lands in the FILE: section id + size LEB + the count
            // and size LEBs inside the payload + the locals header. A relocation is recorded
            // against the instruction stream, and the loader patches a file offset.
            let mut size_leb = Vec::new();
            leb_u(&mut size_leb, p.len() as u64);
            let mut count_leb = Vec::new();
            leb_u(&mut count_leb, 1);
            let mut body_leb = Vec::new();
            leb_u(&mut body_leb, fn_body.len() as u64);
            body_start = out.len() + 1 + size_leb.len() + count_leb.len() + body_leb.len() + locals_len;
            section(&mut out, 10, &p);
        }

        Ok(Unit {
            bytes: out,
            imports: self.imports.iter().map(|i| i.name.clone()).collect(),
            local_count: self.local_types.len(),
            relocs: self.relocs,
            body_start,
        })
    }
}

fn section(out: &mut Vec<u8>, id: u8, payload: &[u8]) {
    out.push(id);
    leb_u(out, payload.len() as u64);
    out.extend_from_slice(payload);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unit {
    pub bytes: Vec<u8>,
    pub imports: Vec<String>,
    pub local_count: usize,
    /// Offsets are relative to the start of the FUNCTION BODY's instruction stream; `body_start`
    /// turns them into file offsets, which is what the loader patches.
    pub relocs: Vec<Relocation>,
    pub body_start: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmitError {
    UnbalancedLabels,
    UnknownLabel,
    StackImbalance { label: &'static str, entered: i32, found: i32 },
    BadSignature(&'static str),
}

impl std::fmt::Display for EmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnbalancedLabels => write!(f, "unbalanced labels at finish()"),
            Self::UnknownLabel => write!(f, "branch to a label that is not open here"),
            Self::StackImbalance { label, entered, found } => write!(
                f,
                "{label} was entered at stack depth {entered} and ends at {found}"
            ),
            Self::BadSignature(k) => write!(f, "unparseable helper signature '{k}'"),
        }
    }
}

impl std::error::Error for EmitError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leb_encodings_match_the_spec() {
        let mut out = Vec::new();
        leb_u(&mut out, 0);
        assert_eq!(out, vec![0x00]);
        out.clear();
        leb_u(&mut out, 624_485);
        assert_eq!(out, vec![0xe5, 0x8e, 0x26]);
        out.clear();
        leb_s(&mut out, -1);
        assert_eq!(out, vec![0x7f]);
        out.clear();
        leb_s(&mut out, -123_456);
        assert_eq!(out, vec![0xc0, 0xbb, 0x78]);
        out.clear();
        // The boundary that a naive signed encoder gets wrong: 64 needs a continuation byte
        // because bit 6 would otherwise read as the sign.
        leb_s(&mut out, 64);
        assert_eq!(out, vec![0xc0, 0x00]);
    }

    #[test]
    fn helper_signatures_are_read_the_way_the_abi_table_writes_them() {
        assert_eq!(FuncType::parse("ii_i").unwrap().params, vec![T_I32, T_I32]);
        assert_eq!(FuncType::parse("ii_i").unwrap().results, vec![T_I32]);
        assert_eq!(FuncType::parse("iii_i").unwrap().params.len(), 3);
        assert!(FuncType::parse("v_v").unwrap().params.is_empty());
        assert!(FuncType::parse("v_v").unwrap().results.is_empty());
        assert_eq!(FuncType::parse("i_v").unwrap().params, vec![T_I32]);
        assert!(FuncType::parse("nonsense").is_none());
    }

    #[test]
    fn the_module_has_the_shape_the_contract_requires() {
        let mut b = ModuleBuilder::new();
        let helper = b.import("safe_read32s_slow_jit", "ii_i").unwrap();
        assert_eq!(helper, 0);
        // Re-importing the same name must reuse the index, or the export index below is wrong.
        assert_eq!(b.import("safe_read32s_slow_jit", "ii_i").unwrap(), 0);
        let scratch = b.local(T_I32);
        assert_eq!(scratch, 1, "local 0 is the entry parameter (N5), so the first local is 1");
        b.const_i32(0).local_set(scratch);
        b.block("exit");
        b.br_to("exit").unwrap();
        assert!(matches!(b.br_to("nope"), Err(EmitError::UnknownLabel)));
        b.end().unwrap();
        let unit = b.finish().unwrap();

        assert_eq!(&unit.bytes[0..8], &[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
        // Section ids in order: type, import, function, export, code (N7).
        let mut ids = Vec::new();
        let mut at = 8;
        while at < unit.bytes.len() {
            ids.push(unit.bytes[at]);
            at += 1;
            let (size, len) = read_leb(&unit.bytes, at);
            at += len + size as usize;
        }
        assert_eq!(ids, vec![1, 2, 3, 7, 10]);
        assert_eq!(unit.imports, vec!["safe_read32s_slow_jit".to_string()]);
        assert_eq!(unit.local_count, 1);
    }

    #[test]
    fn a_five_byte_leb_placeholder_survives_patching_without_moving_anything() {
        let mut out = Vec::new();
        leb_u5(&mut out, 0);
        assert_eq!(out.len(), 5, "the width is what makes a patch not move the body");
        patch_leb_u5(&mut out, 0, 0x1234_5678);
        let mut expected = Vec::new();
        leb_u5(&mut expected, 0x1234_5678);
        assert_eq!(out, expected);
        // ...and it still decodes to the value it was patched with.
        let mut value = 0u32;
        for (i, byte) in out.iter().enumerate() {
            value |= u32::from(byte & 0x7f) << (7 * i);
        }
        assert_eq!(value, 0x1234_5678);
    }

    #[test]
    fn a_relocation_points_at_the_placeholder_it_describes() {
        let mut b = ModuleBuilder::new();
        b.const_i32(0);
        b.load_reloc_offset("tlb_data");
        b.u8(op::DROP);
        let unit = b.finish().unwrap();
        assert_eq!(unit.relocs.len(), 1);
        let at = unit.body_start + unit.relocs[0].at;
        // The five bytes at the recorded site must be the placeholder, i.e. a five-byte zero.
        assert_eq!(&unit.bytes[at..at + 5], &[0x80, 0x80, 0x80, 0x80, 0x00]);
    }

    #[test]
    fn unbalanced_labels_are_refused() {
        let mut b = ModuleBuilder::new();
        b.block("orphan");
        assert_eq!(b.finish(), Err(EmitError::UnbalancedLabels));
        let mut b = ModuleBuilder::new();
        assert!(matches!(b.end(), Err(EmitError::UnbalancedLabels)));
    }

    fn read_leb(bytes: &[u8], at: usize) -> (u64, usize) {
        let mut value = 0u64;
        let mut shift = 0;
        let mut len = 0;
        loop {
            let byte = bytes[at + len];
            value |= ((byte & 0x7f) as u64) << shift;
            len += 1;
            if byte & 0x80 == 0 {
                return (value, len);
            }
            shift += 7;
        }
    }
}
