import { expect, test } from "bun:test";
import { TebManager } from "../../src/worker/core/teb-manager";
function setup() {
    const bytes = new Uint8Array(2 * 1024 * 1024), view = new DataView(bytes.buffer);
    let next = 0x10000;
    const live = new Map<number, number>(), freed: number[] = [];
    const memory = {
        alloc(size: number) { const p = next; next = (next + size + 15) & ~15; live.set(p, size); return p; },
        free(p: number) { if (!live.delete(p)) throw new Error("free of foreign allocation"); freed.push(p); },
    };
    const t = new TebManager(); t.initProcess(() => bytes, memory);
    const a = t.allocateTeb(1, 0x8000, 0x9000, memory), b = t.allocateTeb(2, 0xa000, 0xb000, memory);
    return { t, bytes, view, memory, live, freed, a, b };
}
test("literal native offsets: inline, expansion, implicit index zero, and FLS are disjoint", () => {
    const { t, view, a } = setup();
    t.syncLastError(1, 0x12345678);
    expect(t.syncImplicitTlsSlot(1, 0, 0xabc100)).toBe(true);
    const implicit = view.getUint32(a + 0x2c, true);
    expect(implicit).not.toBe(a + 0xe10);
    expect(view.getUint32(implicit, true)).toBe(0xabc100);
    expect(view.getUint32(a + 0xf94, true)).toBe(0);
    expect(t.readTlsSlot(1, 105)).toBe(0);
    expect(view.getUint32(a + 0xf94, true)).toBe(0);
    for (const i of [0, 63, 64, 105, 1087]) expect(t.syncTlsSlot(1, i, 0x500000 + i)).toBe(true);
    const expansion = view.getUint32(a + 0xf94, true);
    expect(expansion).not.toBe(0);
    for (const i of [0, 63]) expect(view.getUint32(a + 0xe10 + i * 4, true)).toBe(0x500000 + i);
    for (const i of [64, 105, 1087]) expect(view.getUint32(expansion + (i - 64) * 4, true)).toBe(0x500000 + i);
    expect(view.getUint32(implicit, true)).toBe(0xabc100);
    expect(view.getUint32(a + 0xfb4, true)).toBe(0);
    expect(t.syncTlsSlot(1, 1088, 1)).toBe(false);
    expect(t.readTlsSlot(1, 1088)).toBeUndefined();
    expect(t.readLastError(1)).toBe(0x12345678);
});
test("TLS105 cannot redirect FLS; restore frees only owned blocks, preserving another thread", () => {
    const { t, view, memory, a, b, freed } = setup();
    const fa = t.ensureFlsData(1, memory), fb = t.ensureFlsData(2, memory);
    t.writeFlsSlot(1, 7, 0x1111, memory); t.writeFlsSlot(2, 7, 0x2222, memory);
    t.syncTlsSlot(1, 105, 0x18000); t.syncTlsSlot(2, 105, 0x19000);
    expect(view.getUint32(a + 0xfb4, true)).toBe(fa);
    expect(view.getUint32(b + 0xfb4, true)).toBe(fb);
    t.writeFlsSlot(1, 7, 0x3333, memory);
    expect(view.getUint32(fa + 8 + 7 * 4, true)).toBe(0x3333);
    expect(t.readFlsSlot(2, 7)).toBe(0x2222);
    t.restoreState(t.captureState());
    const owned = [a, view.getUint32(a + 0x2c, true), view.getUint32(a + 0xf94, true), fa];
    view.setUint32(a + 0xfb4, 0x1a000, true);
    expect(t.releaseTeb(1, memory)).toBe(true);
    expect(new Set(freed)).toEqual(new Set(owned));
    expect(t.releaseTeb(1, memory)).toBe(false);
    expect(t.readTlsSlot(2, 105)).toBe(0x19000);
    expect(t.readFlsSlot(2, 7)).toBe(0x2222);
});
test("TlsFree clears each native thread store without clearing implicit/FLS values", () => {
    const { t, view, memory, a, b } = setup();
    for (const id of [1, 2]) {
        t.syncImplicitTlsSlot(id, 0, 0x800000 + id);
        t.syncTlsSlot(id, 0, 42); t.syncTlsSlot(id, 105, 43);
        t.writeFlsSlot(id, 1, 44, memory);
    }
    t.clearTlsSlotAllThreads(0); t.clearTlsSlotAllThreads(105);
    for (const [id, teb] of [[1, a], [2, b]]) {
        expect(view.getUint32(teb! + 0xe10, true)).toBe(0);
        const exp = view.getUint32(teb! + 0xf94, true);
        expect(view.getUint32(exp + 41 * 4, true)).toBe(0);
        expect(t.readImplicitTlsSlot(id!, 0)).toBe(0x800000 + id!);
        expect(t.readFlsSlot(id!, 1)).toBe(44);
    }
});


test("failed loader-vector allocation rolls back its new TEB without publishing a thread", () => {
    const { t, memory, live }=setup();
    const before=new Map(live), original=memory.alloc;
    let calls=0;
    memory.alloc=(n:number)=>{ if(++calls===2) throw new Error("allocator failed");return original(n); };
    expect(()=>t.allocateTeb(3,0,0,memory)).toThrow("allocator failed");
    expect(t.getTebAddress(3)).toBeUndefined();
    expect(t.getTlsArrayAddress(3)).toBeUndefined();
    expect(live).toEqual(before);
});

test("implicit native indices64/1087 survive all1088 dynamic writes", () => {
    const {t,view,a,b}=setup();
    for(const id of [1,2]) {
        expect(t.syncImplicitTlsSlot(id,64,0xabc064+id)).toBe(true);
        expect(t.syncImplicitTlsSlot(id,1087,0xabcfff+id)).toBe(true);
        for(let i=0;i<1088;i++) expect(t.syncTlsSlot(id,i,0x700000+i)).toBe(true);
    }
    for(const [id,teb] of [[1,a],[2,b]]) {
        const implicit=view.getUint32(teb!+0x2c,true);
        expect(view.getUint32(implicit+64*4,true)).toBe(0xabc064+id!);
        expect(view.getUint32(implicit+1087*4,true)).toBe(0xabcfff+id!);
        expect(t.syncImplicitTlsSlot(id!,1088,1)).toBe(false);
    }
});
