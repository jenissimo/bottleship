/**
 * MemWriteTrap must not answer a bare zero.
 *
 * The trap serves a #PF by un-protecting the page so the retried store can land. If it
 * never re-protects, the FIRST store to that page — any store, including one nobody asked
 * about — disables the watch permanently, and every later write to the watched dword is
 * silent. That is a false negative on the only question the verb exists to answer, and it
 * is what these cases pin: a second store to the same page must still be attributed, and
 * a write the trap genuinely cannot see (a JS write raises no #PF) must be REPORTED as a
 * change, never folded into `hits: []`.
 *
 * The model below is the real mechanism, not a mock of the trap: a store to a read-only
 * page calls tryHandle() and is then retried exactly as the IRET retries it, and
 * onTickBoundary() runs between instructions exactly as tick_hooks_before does.
 */

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { memWriteTrap } from "../../src/worker/core/memory/mem-write-trap";
import { System } from "../../src/worker/core/system";

const PAGE = 0x1000;
const NOACCESS = 0x01, READONLY = 0x02, READWRITE = 0x04;

const MEM_BYTES = 0x8000;
const PAGE_A = 0x4000;          // the trapped page
const ADDR_NOISE = PAGE_A + 0x10;
const ADDR_WATCH = PAGE_A + 0x20;
const EIP_NOISE = 0x1100;
const EIP_WATCH = 0x1200;

class FakeCpu {
    reg32 = new Int32Array(8);
    instruction_pointer = new Int32Array(1);
    instruction_counter = new Int32Array(1);
}

/** Guest memory + the page-protection state the trap manipulates. */
class FakeMachine {
    mem = new Uint8Array(MEM_BYTES);
    view = new DataView(this.mem.buffer);
    cpu = new FakeCpu();
    protect = new Map<number, number>();

    pageTableManager = {
        isPagingEnabled: () => true,
        setProtection: (base: number, size: number, prot: number) => {
            for (let p = base & ~(PAGE - 1); p < base + size; p += PAGE) this.protect.set(p, prot);
        },
    };
    getCurrentMemory = () => this.mem;
    memory = null;
    moduleRegistry = undefined;

    private prot(addr: number): number {
        return this.protect.get(addr & ~(PAGE - 1)) ?? READWRITE;
    }

    tick(): void {
        memWriteTrap.onTickBoundary(this.cpu);
    }

    /** One guest store instruction at `eip`, then the tick boundary that follows it. */
    store(eip: number, addr: number, value: number): void {
        this.cpu.instruction_pointer[0] = eip;
        if (this.prot(addr) !== READWRITE) {
            // #PF → JS. The trap un-protects and we IRET back to the same instruction;
            // a tick boundary can fall between the fault and the retry.
            const handled = memWriteTrap.tryHandle(addr, eip, true, true, "", this.cpu);
            expect(handled).toBe(true);
            this.tick();                       // still parked on the faulting instruction
            expect(this.prot(addr)).toBe(READWRITE);
        }
        this.view.setUint32(addr, value >>> 0, true);
        this.cpu.instruction_counter[0]++;
        this.cpu.instruction_pointer[0] = eip + 6;   // instruction retired
        this.tick();                                 // the boundary that closes the window
    }

    /** A write from OUR side (an HLE handler). No #PF exists for this, by construction. */
    jsWrite(addr: number, value: number): void {
        this.view.setUint32(addr, value >>> 0, true);
        this.tick();
    }
}

let m: FakeMachine;
// System is a process-wide singleton and bun runs test files in one process: park the
// real `process` and put it back, or every later file inherits this fake.
const realProcess = (System.getInstance() as unknown as { process: unknown }).process;

beforeEach(() => {
    if (memWriteTrap.isArmed()) memWriteTrap.disarm();
    m = new FakeMachine();
    (System.getInstance() as unknown as { process: unknown }).process = m;
});

afterAll(() => {
    if (memWriteTrap.isArmed()) memWriteTrap.disarm();
    (System.getInstance() as unknown as { process: unknown }).process = realProcess;
});

describe("MemWriteTrap watch mode re-arms after every fault", () => {
    test("a store to the watched dword AFTER an unrelated store to the same page is attributed", () => {
        memWriteTrap.arm(ADDR_WATCH, 4, "watch", { watch: true, slice: 1 });
        // The noise store opens the window; without a re-arm the page stays writable and
        // the watched store below lands silently.
        m.store(EIP_NOISE, ADDR_NOISE, 0xdead);
        m.store(EIP_WATCH, ADDR_WATCH, 0x20b01210);

        const r = memWriteTrap.report();
        expect(r.hits.map((h) => h.eip)).toEqual([EIP_WATCH]);
        expect(r.hits[0]!.addr).toBe(ADDR_WATCH);
        expect(r.verdict).toContain("WROTE");
        expect(r.blind.reArms).toBeGreaterThan(0);
    });

    test("repeated writers of one field are all attributed, not just the first", () => {
        memWriteTrap.arm(ADDR_WATCH, 4, "watch", { watch: true, slice: 1 });
        for (let i = 1; i <= 5; i++) {
            m.store(EIP_NOISE, ADDR_NOISE, i);
            m.store(EIP_WATCH, ADDR_WATCH, i);
        }
        expect(memWriteTrap.report().hits.length).toBe(5);
    });

    test("pagesHit counts the pages that faulted (it read 0 with hits recorded)", () => {
        memWriteTrap.arm(ADDR_WATCH, 4, "watch", { watch: true, slice: 1 });
        m.store(EIP_WATCH, ADDR_WATCH, 1);
        const r = memWriteTrap.report();
        expect(r.hits.length).toBe(1);
        expect(r.pagesHit).toBe(1);
    });
});

describe("MemWriteTrap says what it could not see", () => {
    test("a JS write raises no #PF, so it is reported as an UNATTRIBUTED change", () => {
        memWriteTrap.arm(ADDR_WATCH, 4, "js", { watch: true, slice: 1 });
        m.jsWrite(ADDR_WATCH, 0x20b01210);

        const r = memWriteTrap.report();
        expect(r.hits.length).toBe(0);
        expect(r.changed).toBe(true);
        expect(r.unattributedChanges.length).toBeGreaterThan(0);
        expect(r.verdict).toContain("UNATTRIBUTED");
        // No fault ever opened a window, so the trap can name the culprit class exactly.
        expect(r.blind.blindInsns).toBe(0);
        expect(r.verdict).toContain("JS");
    });

    test("nothing wrote at all is a different answer from 'I could not see it'", () => {
        memWriteTrap.arm(ADDR_WATCH, 4, "quiet", { watch: true, slice: 1 });
        m.tick();
        m.tick();
        const r = memWriteTrap.report();
        expect(r.hits.length).toBe(0);
        expect(r.changed).toBe(false);
        expect(r.blind.faults).toBe(0);
        expect(r.verdict).toContain("NO FAULT AT ALL");
    });

    test("the blind window a fault opens is measured, not assumed to be zero", () => {
        memWriteTrap.arm(ADDR_WATCH, 4, "blind", { watch: true, slice: 1 });
        m.store(EIP_NOISE, ADDR_NOISE, 1);
        // The guest retires instructions while the page is writable — that is the window.
        const r = memWriteTrap.report();
        expect(r.blind.faults).toBe(1);
        expect(r.blind.reArms).toBe(1);
        expect(r.blind.ticksObserved).toBeGreaterThan(0);
    });
});

describe("MemWriteTrap single-shot mode", () => {
    test("records the first writer per page and admits the rest is unseen by design", () => {
        memWriteTrap.arm(PAGE_A, 0x100, "single");
        m.store(EIP_NOISE, ADDR_NOISE, 1);
        m.store(EIP_WATCH, ADDR_WATCH, 2);
        const r = memWriteTrap.report();
        expect(r.hits.length).toBe(1);
        expect(r.hits[0]!.eip).toBe(EIP_NOISE);
        expect(r.pagesHit).toBe(1);
    });
});
