// aot-oracle — the seed corpus. BYTE-EXACT extracts from the retail
// NFS Underground binary (tmp/nfsu/Speed.exe, sha256
// c0fad450912952f53809a54690d235aa8b4e25b9f46650693c7cbee1b4c074b7).
//
// Both are position-independent (every memory operand is register-relative, every
// branch is rip-relative), so they can be placed at any address without fixups.
//
// Provenance / why these two:
//   BottleShip's trace2 per-page histogram (plan/nfsu-perf-next-10pct §8.3) names
//   the hot physical pages 0x5d3, 0x5d4, 0x672, 0x40c, 0x5cb. The guest is
//   identity-mapped (CLAUDE.md §2) and Speed.exe has no ASLR (image base
//   0x400000), so phys page P == VA P<<12 == file offset (P<<12)-0x400000+0x1000
//   ... which for this binary is just RVA (raw==virtual for every section).
//   All five hot pages land inside .text (0x401000..0x696ea7) — see the report.
//
//   K1 is the tightest self-contained loop on the HOTTEST page (0x5d3).
//   K2 is the epoch-defining x87 kernel (4x4 vertex transform); page 0x5d3/0x5d4
//   are only 4-5% x87, so K2 stands for the FP-heavy class rather than for NFSU's
//   own top page — it is the direct measurement target for lever B1 (x87 locals).

export const KERNELS = {
    // ── K1: per-element attribute fill, page 0x5d3 (156.6M block-exec / 15 s) ──
    // 25 instructions, 4 basic blocks (5 / 2 / 2 / 16), 16 memory operands,
    // 2 x87 (fild/fstp), 2 lazy-flag consumers whose producer is separated by a
    // flag-neutral `mov` (setne after cmp+mov; jb after cmp+mov) — i.e. exactly
    // the "160 non-fused jcc chains" pattern from plan §2.4.
    //
    // 005d3f1b  8b5104        mov edx, [ecx+4]           ; objIndex
    // 005d3f1e  8bbe8c000000  mov edi, [esi+0x8c]        ; obj table
    // 005d3f24  8b1497        mov edx, [edi+edx*4]       ; obj
    // 005d3f27  837a3800      cmp dword [edx+0x38], 0
    // 005d3f2b  7505          jne 0x5d3f32
    // 005d3f2d  8b7e2c        mov edi, [esi+0x2c]
    // 005d3f30  eb06          jmp 0x5d3f38
    // 005d3f32  8b7e0c        mov edi, [esi+0xc]
    // 005d3f35  8b7f08        mov edi, [edi+8]
    // 005d3f38  8b5228        mov edx, [edx+0x28]        ; array base
    // 005d3f3b  03510c        add edx, [ecx+0xc]
    // 005d3f3e  c1e002        shl eax, 2                 ; eax = i*4
    // 005d3f41  03d0          add edx, eax
    // 005d3f43  33db          xor ebx, ebx
    // 005d3f45  391c3a        cmp [edx+edi], ebx         ; read source word
    // 005d3f48  8b5510        mov edx, [ebp+0x10]        ; dest base (flag-neutral)
    // 005d3f4b  0f95c3        setne bl
    // 005d3f4e  895df8        mov [ebp-8], ebx
    // 005d3f51  db45f8        fild dword [ebp-8]
    // 005d3f54  d91c10        fstp dword [eax+edx]       ; dest[i] = (float)(src!=0)
    // 005d3f57  8b4508        mov eax, [ebp+8]           ; i re-read from the frame
    // 005d3f5a  40            inc eax
    // 005d3f5b  3b450c        cmp eax, [ebp+0xc]
    // 005d3f5e  894508        mov [ebp+8], eax           ; i spilled every iteration
    // 005d3f61  72b8          jb 0x5d3f1b
    k1: {
        va: 0x005d3f1b,
        fileOff: 0x001d3f1b,
        sha256: "f10826b7b83d3d014d4888f2fbf4564d457303212a330866e6d8f3522b94f792",
        insStatic: 25,           // instructions in the extracted byte range
        insPerIter: 23,          // dynamically retired per iteration (one diamond side)
        bytes: new Uint8Array([
            0x8b, 0x51, 0x04, 0x8b, 0xbe, 0x8c, 0x00, 0x00, 0x00, 0x8b, 0x14, 0x97,
            0x83, 0x7a, 0x38, 0x00, 0x75, 0x05, 0x8b, 0x7e, 0x2c, 0xeb, 0x06, 0x8b,
            0x7e, 0x0c, 0x8b, 0x7f, 0x08, 0x8b, 0x52, 0x28, 0x03, 0x51, 0x0c, 0xc1,
            0xe0, 0x02, 0x03, 0xd0, 0x33, 0xdb, 0x39, 0x1c, 0x3a, 0x8b, 0x55, 0x10,
            0x0f, 0x95, 0xc3, 0x89, 0x5d, 0xf8, 0xdb, 0x45, 0xf8, 0xd9, 0x1c, 0x10,
            0x8b, 0x45, 0x08, 0x40, 0x3b, 0x45, 0x0c, 0x89, 0x45, 0x08, 0x72, 0xb8,
        ]),
    },

    // ── K2: 4x4 vertex transform, VA 0x005ae0ec ────────────────────────────────
    // 58 instructions, 48 x87, 43 memory operands, ONE basic block + a 13-instruction
    // flag live range (dec eax ... 4x movsd ... jne). Writes 4 f32 to the [ebp-0x10]
    // staging slot then copies 16 bytes out with 4x movsd.
    //
    // 005ae0ec  d94104   fld [ecx+4]        005ae133  d9410c   fld [ecx+0xc]
    // 005ae0ef  8bfb     mov edi, ebx       005ae136  d84a38   fmul [edx+0x38]
    // 005ae0f1  d84a10   fmul [edx+0x10]    005ae139  d94104   fld [ecx+4]
    // 005ae0f4  035d0c   add ebx,[ebp+0xc]  005ae13c  d84a18   fmul [edx+0x18]
    // 005ae0f7  d94230   fld [edx+0x30]     005ae13f  dec1     faddp st(1)
    // 005ae0fa  8d75f0   lea esi,[ebp-0x10] 005ae141  d94208   fld [edx+8]
    // 005ae0fd  d8490c   fmul [ecx+0xc]     005ae144  d809     fmul [ecx]
    // 005ae100  dec1     faddp st(1)        005ae146  dec1     faddp st(1)
    // 005ae102  d94108   fld [ecx+8]        005ae148  d94108   fld [ecx+8]
    // 005ae105  d84a20   fmul [edx+0x20]    005ae14b  d84a28   fmul [edx+0x28]
    // 005ae108  dec1     faddp st(1)        005ae14e  dec1     faddp st(1)
    // 005ae10a  d901     fld [ecx]          005ae150  d95df8   fstp [ebp-8]
    // 005ae10c  d80a     fmul [edx]         005ae153  d94108   fld [ecx+8]
    // 005ae10e  dec1     faddp st(1)        005ae156  d84a2c   fmul [edx+0x2c]
    // 005ae110  d95df0   fstp [ebp-0x10]    005ae159  d9420c   fld [edx+0xc]
    // 005ae113  d94108   fld [ecx+8]        005ae15c  d809     fmul [ecx]
    // 005ae116  d84a24   fmul [edx+0x24]    005ae15e  dec1     faddp st(1)
    // 005ae119  d901     fld [ecx]          005ae160  d94104   fld [ecx+4]
    // 005ae11b  d84a04   fmul [edx+4]       005ae163  d84a1c   fmul [edx+0x1c]
    // 005ae11e  dec1     faddp st(1)        005ae166  dec1     faddp st(1)
    // 005ae120  d94104   fld [ecx+4]        005ae168  d9410c   fld [ecx+0xc]
    // 005ae123  d84a14   fmul [edx+0x14]    005ae16b  034d14   add ecx,[ebp+0x14]
    // 005ae126  dec1     faddp st(1)        005ae16e  48       dec eax
    // 005ae128  d94234   fld [edx+0x34]     005ae16f  d84a3c   fmul [edx+0x3c]
    // 005ae12b  d8490c   fmul [ecx+0xc]     005ae172  dec1     faddp st(1)
    // 005ae12e  dec1     faddp st(1)        005ae174  d95dfc   fstp [ebp-4]
    // 005ae130  d95df4   fstp [ebp-0xc]     005ae177  a5 a5 a5 a5   movsd x4
    //                                       005ae17b  0f856b.. jne 0x5ae0ec
    k2: {
        va: 0x005ae0ec,
        fileOff: 0x001ae0ec,
        sha256: "b064d50c6b398110aaa84510395533ad52f835bf7ab6a08c10f048969271ecd1",
        insStatic: 58,
        insPerIter: 58,          // single basic block: every instruction, every iteration
        bytes: new Uint8Array([
            0xd9, 0x41, 0x04, 0x8b, 0xfb, 0xd8, 0x4a, 0x10, 0x03, 0x5d, 0x0c, 0xd9,
            0x42, 0x30, 0x8d, 0x75, 0xf0, 0xd8, 0x49, 0x0c, 0xde, 0xc1, 0xd9, 0x41,
            0x08, 0xd8, 0x4a, 0x20, 0xde, 0xc1, 0xd9, 0x01, 0xd8, 0x0a, 0xde, 0xc1,
            0xd9, 0x5d, 0xf0, 0xd9, 0x41, 0x08, 0xd8, 0x4a, 0x24, 0xd9, 0x01, 0xd8,
            0x4a, 0x04, 0xde, 0xc1, 0xd9, 0x41, 0x04, 0xd8, 0x4a, 0x14, 0xde, 0xc1,
            0xd9, 0x42, 0x34, 0xd8, 0x49, 0x0c, 0xde, 0xc1, 0xd9, 0x5d, 0xf4, 0xd9,
            0x41, 0x0c, 0xd8, 0x4a, 0x38, 0xd9, 0x41, 0x04, 0xd8, 0x4a, 0x18, 0xde,
            0xc1, 0xd9, 0x42, 0x08, 0xd8, 0x09, 0xde, 0xc1, 0xd9, 0x41, 0x08, 0xd8,
            0x4a, 0x28, 0xde, 0xc1, 0xd9, 0x5d, 0xf8, 0xd9, 0x41, 0x08, 0xd8, 0x4a,
            0x2c, 0xd9, 0x42, 0x0c, 0xd8, 0x09, 0xde, 0xc1, 0xd9, 0x41, 0x04, 0xd8,
            0x4a, 0x1c, 0xde, 0xc1, 0xd9, 0x41, 0x0c, 0x03, 0x4d, 0x14, 0x48, 0xd8,
            0x4a, 0x3c, 0xde, 0xc1, 0xd9, 0x5d, 0xfc, 0xa5, 0xa5, 0xa5, 0xa5, 0x0f,
            0x85, 0x6b, 0xff, 0xff, 0xff,
        ]),
    },

    // ── K3: the INTEGER sibling of K1, page 0x5d4 ─────────────────────────────
    // Same attribute-fill idiom with the x87 store replaced by an integer one, so it is the
    // mov / ALU / branch / memory core with nothing else in it: one memory read, one memory
    // write, a lazy-flag producer whose consumer is two instructions away, a setcc, and a
    // register-counted self-loop. 7 instructions, ONE basic block, 2 memory operands (29%),
    // 1 branch (14%) — the shape plan/aot-compiler-handoff.md §1 names as NFSU's real hot code.
    //
    // 005d4f87  33d2      xor edx, edx
    // 005d4f89  391439    cmp [ecx+edi], edx        ; read source word
    // 005d4f8c  0f95c2    setne dl
    // 005d4f8f  8911      mov [ecx], edx            ; dst[i] = (src[i] != 0)
    // 005d4f92  83c104    add ecx, 4
    // 005d4f95  48        dec eax
    // 005d4f96  75f0      jne 0x5d4f87
    k3: {
        va: 0x005d4f87,
        fileOff: 0x001d4f87,
        sha256: "f92e8ad00d112bc46ea8bab9fd401410e4cefc3b9ad8ff4a21be9d67d44ae345",
        insStatic: 7,
        insPerIter: 7,
        bytes: new Uint8Array([
            0x33, 0xd2, 0x39, 0x14, 0x39, 0x0f, 0x95, 0xc2, 0x89, 0x11, 0x83, 0xc1,
            0x04, 0x48, 0x75, 0xf0,
        ]),
    },

    // ── K4: triple-nested block copy, page 0x5cb ──────────────────────────────
    // Chosen for the two things K3 cannot exercise: a real CFG (7 basic blocks, two
    // branch diamonds, three back edges, one of them a self-loop) and READ-MODIFY-WRITE
    // memory operands — `dec dword [ebp-0xc]`, `add dword [ebp+0x14], edi`,
    // `add dword [ebp-8], 0x10` — which have NO fastmem variant and must use the
    // two-phase TLB shape (contract N40 / D3). 30 static instructions, 13 memory operands.
    //
    // 005cbd78  8b4dfc     mov ecx, [ebp-4]        005cbda3  8b19    mov ebx, [ecx]
    // 005cbd7b  85c9       test ecx, ecx           005cbda5  891e    mov [esi], ebx
    // 005cbd7d  763f       jbe 0x5cbdbe            005cbda7  83c104  add ecx, 4
    // 005cbd7f  8b7510     mov esi, [ebp+0x10]     005cbdaa  83c604  add esi, 4
    // 005cbd82  8975f8     mov [ebp-8], esi        005cbdad  ff4df4  dec dword [ebp-0xc]
    // 005cbd85  8b750c     mov esi, [ebp+0xc]      005cbdb0  75f1    jne 0x5cbda3
    // 005cbd88  8bfa       mov edi, edx            005cbdb2  017d14  add [ebp+0x14], edi
    // 005cbd8a  c1e702     shl edi, 2              005cbdb5  8345f810 add [ebp-8], 0x10
    // 005cbd8d  897514     mov [ebp+0x14], esi     005cbdb9  ff4df0  dec dword [ebp-0x10]
    // 005cbd90  894df0     mov [ebp-0x10], ecx     005cbdbc  75d5    jne 0x5cbd93
    // 005cbd93  8b5d08     mov ebx, [ebp+8]        005cbdbe  01450c  add [ebp+0xc], eax
    // 005cbd96  85db       test ebx, ebx           005cbdc1  83451040 add [ebp+0x10], 0x40
    // 005cbd98  7618       jbe 0x5cbdb2            005cbdc5  ff4dec  dec dword [ebp-0x14]
    // 005cbd9a  8b7514     mov esi, [ebp+0x14]     005cbdc8  75ae    jne 0x5cbd78
    // 005cbd9d  8b4df8     mov ecx, [ebp-8]
    // 005cbda0  895df4     mov [ebp-0xc], ebx
    k4: {
        va: 0x005cbd78,
        fileOff: 0x001cbd78,
        sha256: "9344e7fbf320a3e077d36cb1c5000a2fed5adf508eaf405d806b329e297b77e1",
        insStatic: 30,
        // Dynamic count for the fixture's trip counts (OUTER=2, MID=3, INNER=8), analytic:
        //   outer body = 3 + 7 + MID*(3 + 3 + 6*INNER + 4) + 4 = 188 ; x OUTER = 376
        insPerIter: 376,
        bytes: new Uint8Array([
            0x8b, 0x4d, 0xfc, 0x85, 0xc9, 0x76, 0x3f, 0x8b, 0x75, 0x10, 0x89, 0x75,
            0xf8, 0x8b, 0x75, 0x0c, 0x8b, 0xfa, 0xc1, 0xe7, 0x02, 0x89, 0x75, 0x14,
            0x89, 0x4d, 0xf0, 0x8b, 0x5d, 0x08, 0x85, 0xdb, 0x76, 0x18, 0x8b, 0x75,
            0x14, 0x8b, 0x4d, 0xf8, 0x89, 0x5d, 0xf4, 0x8b, 0x19, 0x89, 0x1e, 0x83,
            0xc1, 0x04, 0x83, 0xc6, 0x04, 0xff, 0x4d, 0xf4, 0x75, 0xf1, 0x01, 0x7d,
            0x14, 0x83, 0x45, 0xf8, 0x10, 0xff, 0x4d, 0xf0, 0x75, 0xd5, 0x01, 0x45,
            0x0c, 0x83, 0x45, 0x10, 0x40, 0xff, 0x4d, 0xec, 0x75, 0xae,
        ]),
    },
};

/** Re-extract from the real binary if present; throws on mismatch. */
export async function verifyAgainstBinary(exePath) {
    const fs = await import("node:fs");
    const crypto = await import("node:crypto");
    if (!fs.existsSync(exePath)) return { checked: false, reason: "Speed.exe not present" };
    const buf = fs.readFileSync(exePath);
    const out = {};
    for (const [name, k] of Object.entries(KERNELS)) {
        const slice = buf.subarray(k.fileOff, k.fileOff + k.bytes.length);
        const same = Buffer.compare(Buffer.from(k.bytes), slice) === 0;
        const sha = crypto.createHash("sha256").update(slice).digest("hex");
        out[name] = { same, sha, expected: k.sha256 };
        if (!same || sha !== k.sha256) throw new Error(`kernel ${name} does not match ${exePath}`);
    }
    return { checked: true, kernels: out };
}
