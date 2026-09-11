#include "codegen.h"

CgState cg_data;
extern "C" volatile uint32_t cg_go = 0;
CG_EXPORT CgState* cg_state() { return &cg_data; }
CG_EXPORT uint32_t cg_size() { return sizeof(CgState); }

// Six kernels shaped after what NFSU's hot pages actually do (Ghidra: FUN_005cdca7 render
// walker, FUN_005d01ec sub-object loop, FUN_0040f1e0 command-list builder, FUN_0040a580 frame
// driver). The measured instruction mix there is MOV-dominated pointer chasing with
// compare/branch and stride IMULs, not pixel ALU. One instruction family per kernel, so a
// codegen difference can be attributed to a family instead of to the demo as a whole.

/** The per-tag helpers the walker calls; kept out of line exactly like the game's are. */
static CG_SECTION(".cgkla") uint32_t cg_leaf_a(uint32_t row, uint32_t sel) {
    const CgRow& r = cg_data.rows[row & (CG_ROWS - 1)];
    return r.link + (uint32_t(r.sel) ^ sel) + r.flags;
}
static CG_SECTION(".cgklb") uint32_t cg_leaf_b(uint32_t row, uint32_t sel) {
    const CgRow& r = cg_data.rows[row & (CG_ROWS - 1)];
    return (r.aux * 0x1cu) ^ (uint32_t(r.tag) << 3) ^ sel;
}
static CG_SECTION(".cgklc") uint32_t cg_leaf_c(uint32_t row, uint32_t sel) {
    const CgRow& r = cg_data.rows[row & (CG_ROWS - 1)];
    return r.link ^ (r.aux + sel * 0x3cu);
}

/** Recursive tag-dispatched graph walk: the shape of FUN_005cdca7. */
static CG_SECTION(".cgkvis") uint32_t cg_visit(uint32_t node, uint32_t depth) {
    if (node >= CG_NODES || depth > 6u) return 0;
    const CgNode& n = cg_data.nodes[node];
    ++cg_data.visited;
    uint32_t value;
    switch (n.tag & 3u) {
        case 0: value = cg_leaf_a(n.row, n.sel); break;
        case 1: value = cg_leaf_b(n.row, n.sel); break;
        case 2: value = cg_leaf_c(n.row, n.sel); break;
        default: {
            value = n.payload;
            uint32_t child = n.child;
            while (child < CG_NODES) {
                value += cg_visit(child, depth + 1u);
                child = cg_data.nodes[child].sibling;
                if (child == 0) break;
            }
            break;
        }
    }
    return value ^ (n.payload + depth);
}

CG_KERNEL(".cgk1") void cg_k1_walk(uint32_t count) {
    uint32_t acc = cg_data.acc, cursor = cg_data.cursor;
    for (uint32_t i = 0; i < count; ++i) {
        acc += cg_visit(cursor & (CG_NODES - 1), 0);
        cursor += 7u;
    }
    cg_data.acc = acc;
    cg_data.cursor = cursor;
}

/** Free-list allocator plus doubly-linked splice: the shape of FUN_0040f1e0 + FUN_00567160. */
static CG_SECTION(".cgkal") uint32_t cg_alloc() {
    const uint32_t head = cg_data.freeHead;
    if (head >= CG_CMDS) return 0xffffffffu;
    cg_data.freeHead = cg_data.cmds[head].next;
    ++cg_data.allocs;
    return head;
}
static CG_SECTION(".cgkrel") void cg_release(uint32_t cmd) {
    cg_data.cmds[cmd].next = cg_data.freeHead;
    cg_data.freeHead = cmd;
}
/** Recycle half the command pool, the way a frame's list is drained and refilled. */
static CG_SECTION(".cgkdr") void cg_drain() {
    uint32_t node = cg_data.listHead, drained = 0;
    while (node < CG_CMDS && drained < CG_CMDS / 2u) {
        const uint32_t next = cg_data.cmds[node].next;
        cg_release(node);
        node = next;
        ++drained;
        --cg_data.listCount;
    }
    cg_data.listHead = node < CG_CMDS ? node : CG_CMDS;
    if (cg_data.listHead >= CG_CMDS) cg_data.listTail = CG_CMDS;
}
static CG_SECTION(".cgksp") void cg_splice(uint32_t cmd) {
    CgCmd& c = cg_data.cmds[cmd];
    c.next = CG_CMDS;
    c.prev = cg_data.listTail;
    if (cg_data.listTail < CG_CMDS) cg_data.cmds[cg_data.listTail].next = cmd;
    else cg_data.listHead = cmd;
    cg_data.listTail = cmd;
    ++cg_data.listCount;
    ++cg_data.emitted;
}

CG_KERNEL(".cgk2") void cg_k2_list(uint32_t count) {
    uint32_t h = cg_data.carry;
    for (uint32_t i = 0; i < count; ++i) {
        const uint32_t cmd = cg_alloc();
        if (cmd == 0xffffffffu) { cg_drain(); continue; }
        CgCmd& c = cg_data.cmds[cmd];
        c.kind = h & 3u;
        c.a = h; c.b = h >> 3; c.c = h * 0x1cu; c.d = h ^ i; c.e = i;
        cg_splice(cmd);
        h = h * 1664525u + 1013904223u;
    }
    cg_data.carry = h;
}

/** Odd-stride table indexing with mixed 8/16/32-bit loads: the IMUL+MOV core of the walker. */
CG_KERNEL(".cgk3") void cg_k3_stride(uint32_t count) {
    uint32_t acc = cg_data.acc, cursor = cg_data.cursor;
    for (uint32_t i = 0; i < count; ++i) {
        const uint32_t row = (cursor * 0x1cu >> 4) & (CG_ROWS - 1);
        CgRow& r = cg_data.rows[row];
        const uint16_t sel = r.sel;
        const uint8_t low = r.pad[(cursor >> 2) & (CG_ROW_STRIDE - 17)];
        acc += uint32_t(sel) * 0x3cu + uint32_t(low);
        r.flags = (r.flags + acc) ^ uint32_t(r.tag);
        r.sel = uint16_t(sel + uint16_t(i));
        r.pad[(cursor >> 3) & (CG_ROW_STRIDE - 17)] = uint8_t(acc >> 8);
        cursor += 0xacu;
    }
    cg_data.acc = acc;
    cg_data.cursor = cursor;
}

typedef uint32_t (*CgOp)(uint32_t, uint32_t);
static uint32_t op_add(uint32_t a, uint32_t b) { return a + b; }
static uint32_t op_xor(uint32_t a, uint32_t b) { return a ^ (b << 3); }
static uint32_t op_mul(uint32_t a, uint32_t b) { return a * (b | 1u); }
static uint32_t op_rot(uint32_t a, uint32_t b) { const uint32_t s = b & 31u; return (a << s) | (a >> ((32u - s) & 31u)); }
static const CgOp cg_ops[4] = { op_add, op_xor, op_mul, op_rot };

/** Indirect calls through a table: the game's per-tag helpers and COM vtable calls. */
CG_KERNEL(".cgk4") void cg_k4_indirect(uint32_t count) {
    uint32_t acc = cg_data.acc, h = cg_data.carry;
    for (uint32_t i = 0; i < count; ++i) {
        acc = cg_ops[h & 3u](acc, h);
        h = h * 1664525u + 1013904223u;
    }
    cg_data.acc = acc;
    cg_data.carry = h;
}

/** x87 transform work: the float10 the decompiler reports inside the walker. */
CG_KERNEL(".cgk5") void cg_k5_x87(uint32_t count) {
    double sum = cg_data.fsum;
    uint32_t cursor = cg_data.cursor;
    for (uint32_t i = 0; i < count; ++i) {
        const uint32_t v = (cursor & (CG_VERTS - 1)) * 4u;
        const double x = cg_data.verts[v], y = cg_data.verts[v + 1];
        const double z = cg_data.verts[v + 2], w = cg_data.verts[v + 3];
        const double ox = cg_data.matrix[0] * x + cg_data.matrix[1] * y + cg_data.matrix[2] * z + cg_data.matrix[3] * w;
        const double oy = cg_data.matrix[4] * x + cg_data.matrix[5] * y + cg_data.matrix[6] * z + cg_data.matrix[7] * w;
        const double oz = cg_data.matrix[8] * x + cg_data.matrix[9] * y + cg_data.matrix[10] * z + cg_data.matrix[11] * w;
        const double ow = cg_data.matrix[12] * x + cg_data.matrix[13] * y + cg_data.matrix[14] * z + cg_data.matrix[15] * w;
        sum += ox + oy + oz + ow;
        cg_data.words[cursor & 1023u] = uint32_t(int32_t(ox)) ^ uint32_t(int32_t(oy));
        cursor += 5u;
    }
    cg_data.fsum = sum;
    cg_data.cursor = cursor;
}

/** The composite: walk the graph and emit a command per visited node, like one game frame. */
CG_KERNEL(".cgk6") void cg_k6_frame(uint32_t count) {
    uint32_t cursor = cg_data.cursor, acc = cg_data.acc;
    for (uint32_t i = 0; i < count; ++i) {
        const uint32_t node = cursor & (CG_NODES - 1);
        const uint32_t value = cg_visit(node, 0);
        const uint32_t cmd = cg_alloc();
        if (cmd != 0xffffffffu) {
            CgCmd& c = cg_data.cmds[cmd];
            c.kind = cg_data.nodes[node].tag & 3u;
            c.a = value;
            c.b = cg_data.nodes[node].payload;
            c.c = cursor;
            c.d = cg_leaf_a(cg_data.nodes[node].row, cg_data.nodes[node].sel);
            c.e = i;
            cg_splice(cmd);
        } else {
            cg_drain();
        }
        acc += value;
        cursor += 3u;
    }
    cg_data.cursor = cursor;
    cg_data.acc = acc;
}

CG_EXPORT void cg_init(uint32_t seed) {
    cg_data.magic = 0x43474e32;      // "CGN2"
    cg_data.version = 2;
    cg_data.seed = seed;
    cg_data.kernel = cg_data.count = cg_data.rounds = 0;
    cg_data.acc = seed ^ 0x9e3779b9u;
    cg_data.cursor = 0;
    cg_data.carry = seed | 1u;
    cg_data.visited = cg_data.emitted = cg_data.allocs = 0;
    cg_data.fsum = 0.0;
    uint32_t x = seed;
    for (uint32_t i = 0; i < 1024; ++i) { x = x * 1664525u + 1013904223u; cg_data.words[i] = x; }
    for (uint32_t i = 0; i < CG_ROWS; ++i) {
        CgRow& r = cg_data.rows[i];
        x = x * 1664525u + 1013904223u; r.tag = uint16_t(x >> 16);
        x = x * 1664525u + 1013904223u; r.sel = uint16_t(x >> 16);
        x = x * 1664525u + 1013904223u; r.link = x;
        x = x * 1664525u + 1013904223u; r.aux = x;
        x = x * 1664525u + 1013904223u; r.flags = x;
        for (uint32_t b = 0; b < CG_ROW_STRIDE - 16; ++b) {
            x = x * 1664525u + 1013904223u;
            r.pad[b] = uint8_t(x >> 24);
        }
    }
    // A shallow forest: children always point forward, so the walk terminates without a
    // visited set, and the depth cap is a guard rather than the shape being measured.
    for (uint32_t i = 0; i < CG_NODES; ++i) {
        CgNode& n = cg_data.nodes[i];
        x = x * 1664525u + 1013904223u; n.tag = uint16_t(x >> 16);
        x = x * 1664525u + 1013904223u; n.sel = uint16_t(x >> 16);
        x = x * 1664525u + 1013904223u; n.row = x % CG_ROWS;
        x = x * 1664525u + 1013904223u; n.payload = x;
        x = x * 1664525u + 1013904223u;
        const uint32_t child = i + 1u + (x % 8u);
        n.child = child < CG_NODES ? child : CG_NODES;
        x = x * 1664525u + 1013904223u;
        const uint32_t sibling = child + 1u + (x % 8u);
        n.sibling = sibling < CG_NODES ? sibling : 0u;
    }
    for (uint32_t i = 0; i < CG_CMDS; ++i) {
        cg_data.cmds[i].next = i + 1u;
        cg_data.cmds[i].prev = CG_CMDS;
        cg_data.cmds[i].kind = 0;
        cg_data.cmds[i].a = cg_data.cmds[i].b = cg_data.cmds[i].c = 0;
        cg_data.cmds[i].d = cg_data.cmds[i].e = 0;
    }
    cg_data.cmds[CG_CMDS - 1].next = CG_CMDS;
    cg_data.freeHead = 0;
    cg_data.listHead = cg_data.listTail = CG_CMDS;
    cg_data.listCount = 0;
    for (uint32_t i = 0; i < CG_VERTS * 4; ++i) {
        x = x * 1664525u + 1013904223u;
        cg_data.verts[i] = double(int32_t(x % 2048u) - 1024);
    }
    for (uint32_t i = 0; i < 16; ++i) {
        x = x * 1664525u + 1013904223u;
        cg_data.matrix[i] = double(int32_t(x % 7u) - 3);
    }
}

CG_EXPORT uint32_t cg_checksum() {
    const uint8_t* p = reinterpret_cast<const uint8_t*>(&cg_data);
    uint32_t h = 2166136261u;
    for (uint32_t i = 0; i < sizeof(CgState); ++i) { h ^= p[i]; h *= 16777619u; }
    return h;
}

CG_EXPORT void cg_run(uint32_t kernel, uint32_t count, uint32_t rounds) {
    if (kernel < 1 || kernel > 6 || !count || !rounds) return;
    cg_data.kernel = kernel;
    cg_data.count = count;
    cg_data.rounds = rounds;
    for (uint32_t r = 0; r < rounds; ++r) {
        switch (kernel) {
            case 1: cg_k1_walk(count); break;
            case 2: cg_k2_list(count); break;
            case 3: cg_k3_stride(count); break;
            case 4: cg_k4_indirect(count); break;
            case 5: cg_k5_x87(count); break;
            case 6: cg_k6_frame(count); break;
        }
    }
}
