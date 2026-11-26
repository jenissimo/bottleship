import { describe, expect, test } from "bun:test";
import { BottleShipMachine } from "../../src/worker/wwt/machine";
import { resolveWwtMode } from "../../src/worker/wwt/mode";
import { WwtCompiler, WwtTranslationStackOverflow } from "../../src/worker/wwt/translator";
import { WwtWallClock } from "../../src/worker/wwt/wall-clock";

const GUEST_LIMIT = 4 << 20;
const PARK = 0x20000;
const STACK = 0x18000;

async function fastMachine() {
    const file = Bun.file(new URL("../../public/wwt-provider/wwt_abi11.wasm", import.meta.url));
    const compiler = await WwtCompiler.fromBytes(await file.arrayBuffer(), true);
    expect(compiler.abi.version).toBe(11);
    const machine = new BottleShipMachine(compiler, GUEST_LIMIT, 0x40000, 0);
    await machine.init();
    return { compiler, machine };
}

describe("WWT execution mode", () => {
    test("uses fast unless a manifest or explicit compatibility option asks for protected", () => {
        expect(resolveWwtMode(undefined, undefined)).toBe("fast");
        expect(resolveWwtMode(undefined, "protected")).toBe("protected");
        expect(resolveWwtMode(undefined, "unknown")).toBe("fast");
        expect(resolveWwtMode("fast", "protected", "paged", "page-local")).toBe("fast");
        expect(resolveWwtMode("protected", "fast")).toBe("protected");
        expect(resolveWwtMode(undefined, "fast", "paged")).toBe("protected");
        expect(resolveWwtMode(undefined, undefined, undefined, "page-local")).toBe("protected");
        expect(resolveWwtMode(undefined, undefined)).toBe("fast");
    });

    test("uses unsigned wall deadlines and rotates the epoch before wrap", () => {
        const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
        const clock = new WwtWallClock(memory, 4);
        const words = new Uint32Array(memory.buffer);
        Atomics.store(words, 1, 100);
        expect(clock.arm(15.625)).toBe(116);
        Atomics.store(words, 1, 0xfffeffff);
        expect(clock.arm(20)).toBe(0xffff0013);
        Atomics.store(words, 1, 0xffff0000);
        expect(clock.arm(20)).toBeUndefined();
        clock.dispose();
    });
});

describe("fast ABI11 in the BottleShip runtime", () => {
    test("copies full-width integers through FILD, FXCH and FISTP", async () => {
        const { compiler, machine } = await fastMachine();
        try {
            const cpu = machine.newCpu();
            const { GPR, PREEMPT_AT, FPU_TOP, FPU_TAG } = machine.abi.cpu;
            const bytes = new Uint8Array(machine.memory.buffer);
            const view = new DataView(bytes.buffer);
            const source = STACK + 0x100;
            const target = STACK + 0x200;
            const code = Uint8Array.of(
                0xdf, 0x2e,                         // fild qword [esi]
                0xdf, 0x6e, 0x08,                   // fild qword [esi+8]
                0xd9, 0xc9,                         // fxch st(1)
                0x26, 0xdf, 0x3f,                   // fistp qword es:[edi]
                0x26, 0xdf, 0x7f, 0x08,             // fistp qword es:[edi+8]
                0xc3,
            );
            bytes.set(code, PARK);
            view.setBigInt64(source, 0x7fff_ffff_ffff_ffffn, true);
            view.setBigInt64(source + 8, -0x1234_5678_9abc_defn, true);
            view.setUint32(cpu + GPR + 4 * 4, STACK, true);
            view.setUint32(cpu + GPR + 6 * 4, source, true);
            view.setUint32(cpu + GPR + 7 * 4, target, true);
            view.setUint32(STACK, machine.stopAddress, true);
            view.setUint32(cpu + PREEMPT_AT, 1000, true);
            machine.loadModuleSync(compiler.translate(code, PARK, [], GUEST_LIMIT, false, 1), "x87-copy");
            expect(machine.run(cpu, PARK)).toBe(machine.stopAddress);
            expect(view.getBigInt64(target, true)).toBe(view.getBigInt64(source, true));
            expect(view.getBigInt64(target + 8, true)).toBe(view.getBigInt64(source + 8, true));
            expect(view.getUint32(cpu + FPU_TOP, true)).toBe(0);
            expect(view.getUint8(cpu + FPU_TAG)).toBe(0);
        } finally { machine.dispose(); }
    });

    for (const stackSelector of [0x10, 0x2b]) {
        test(`flat DS/ES selector 0x10 follows the active stack selector 0x${stackSelector.toString(16)}`, async () => {
            const { compiler, machine } = await fastMachine();
            try {
                const cpu = machine.newCpu();
                const { GPR, PREEMPT_AT, SEG_SEL } = machine.abi.cpu;
                const bytes = new Uint8Array(machine.memory.buffer);
                const view = new DataView(bytes.buffer);
                // mov ds,[ebp+0x14]; mov es,[ebp+0xc]; mov eax,42; ret
                const code = Uint8Array.of(0x66, 0x8e, 0x5d, 0x14, 0x66, 0x8e, 0x45, 0x0c, 0xb8, 42, 0, 0, 0, 0xc3);
                bytes.set(code, PARK);
                machine.loadModuleSync(compiler.translate(code, PARK, [], GUEST_LIMIT, false, 1), "segment-load");
                view.setUint32(cpu + GPR + 4 * 4, STACK, true);
                view.setUint32(cpu + GPR + 5 * 4, STACK, true);
                view.setUint32(STACK, machine.stopAddress, true);
                view.setUint16(STACK + 0x0c, 0x10, true);
                view.setUint16(STACK + 0x14, 0x10, true);
                view.setUint16(cpu + SEG_SEL + 2 * 2, stackSelector, true);
                view.setUint16(cpu + SEG_SEL, 0x2b, true);
                view.setUint16(cpu + SEG_SEL + 3 * 2, 0x2b, true);
                view.setUint32(cpu + PREEMPT_AT, 1000, true);
                const faults: { code: number; eip: number }[] = [];
                machine.onFault = (_cpu, code, eip) => {
                    faults.push({ code, eip });
                    return machine.stopAddress;
                };
                expect(machine.run(cpu, PARK)).toBe(machine.stopAddress);
                if (stackSelector === 0x10) {
                    expect(faults).toEqual([]);
                    expect(view.getUint16(cpu + SEG_SEL + 3 * 2, true)).toBe(0x10);
                    expect(view.getUint16(cpu + SEG_SEL, true)).toBe(0x10);
                    expect(view.getUint32(cpu + GPR, true)).toBe(42);
                } else {
                    expect(faults).toEqual([{ code: machine.abi.fault.GENERAL_PROTECTION, eip: PARK }]);
                    expect(view.getUint16(cpu + SEG_SEL + 3 * 2, true)).toBe(0x2b);
                    expect(view.getUint16(cpu + SEG_SEL, true)).toBe(0x2b);
                }
            } finally { machine.dispose(); }
        });
    }

    for (const opt of [0, 1]) {
        test(`an OSR loop at opt ${opt} yields with the live state and resumes at its header`, async () => {
            const { compiler, machine } = await fastMachine();
            try {
                const cpu = machine.newCpu();
                const { GPR, PREEMPT_AT, RESUME } = machine.abi.cpu;
                const bytes = new Uint8Array(machine.memory.buffer);
                const words = new Uint32Array(bytes.buffer);
                // mov ecx,112; dec ecx; jnz back to dec; ret. The finite count
                // lets a compiler missing its deadline poll fail without hanging.
                const code = Uint8Array.of(0xb9, 112, 0, 0, 0, 0x49, 0x75, 0xfd, 0xc3);
                bytes.set(code, PARK);
                machine.codeEnd = () => PARK + code.length;
                machine.loadModuleSync(compiler.translate(code, PARK, [], GUEST_LIMIT, false, opt), "countdown");
                words[(cpu + GPR + 16) >>> 2] = STACK;
                words[STACK >>> 2] = machine.stopAddress;
                words[machine.tickAddr >>> 2] = 100;
                words[(cpu + PREEMPT_AT) >>> 2] = 99;
                let resume = 0;
                machine.onPreempt = (_cpu, pc) => { resume = pc; return true; };
                expect(machine.run(cpu, PARK)).toBe(machine.yieldAddress);
                expect(resume).toBe(PARK + 5);
                expect(words[(cpu + GPR + 4) >>> 2]).toBe(111);
                expect(words[(cpu + GPR + 16) >>> 2]).toBe(STACK);
                expect(words[(cpu + RESUME) >>> 2]).toBe(0);
                words[(cpu + PREEMPT_AT) >>> 2] = 101;
                expect(machine.run(cpu, resume)).toBe(machine.stopAddress);
                expect(words[(cpu + GPR + 4) >>> 2]).toBe(0);
                expect(words[(cpu + GPR + 16) >>> 2]).toBe(STACK + 4);
            } finally { machine.dispose(); }
        });

        test(`an entry loop at opt ${opt} still yields when OSR relocates its header`, async () => {
            const { compiler, machine } = await fastMachine();
            try {
                const cpu = machine.newCpu();
                const { GPR, PREEMPT_AT, RESUME } = machine.abi.cpu;
                const bytes = new Uint8Array(machine.memory.buffer);
                const words = new Uint32Array(bytes.buffer);
                // Two successive countdowns. OSR applies to the second loop
                // and moves the original entry, which is itself a loop header.
                const code = Uint8Array.of(0x48, 0x75, 0xfd, 0x49, 0x75, 0xfd, 0xc3);
                bytes.set(code, PARK);
                machine.codeEnd = () => PARK + code.length;
                machine.loadModuleSync(compiler.translate(code, PARK, [], GUEST_LIMIT, false, opt), "entry-loop");
                words[(cpu + GPR) >>> 2] = 112;
                words[(cpu + GPR + 4) >>> 2] = 83;
                words[(cpu + GPR + 16) >>> 2] = STACK;
                words[STACK >>> 2] = machine.stopAddress;
                words[machine.tickAddr >>> 2] = 100;
                words[(cpu + PREEMPT_AT) >>> 2] = 99;
                let resume = 0;
                machine.onPreempt = (_cpu, pc) => { resume = pc; return true; };
                expect(machine.run(cpu, PARK)).toBe(machine.yieldAddress);
                expect(resume).toBe(PARK);
                expect(words[(cpu + GPR) >>> 2]).toBe(111);
                expect(words[(cpu + GPR + 4) >>> 2]).toBe(83);
                expect(words[(cpu + RESUME) >>> 2]).toBe(0);
                words[(cpu + PREEMPT_AT) >>> 2] = 101;
                expect(machine.run(cpu, resume)).toBe(machine.stopAddress);
                expect(words[(cpu + GPR) >>> 2]).toBe(0);
                expect(words[(cpu + GPR + 4) >>> 2]).toBe(0);
                expect(words[(cpu + GPR + 16) >>> 2]).toBe(STACK + 4);
            } finally { machine.dispose(); }
        });

        test(`a backward jump to another demand module at opt ${opt} polls the scheduler`, async () => {
            const { compiler, machine } = await fastMachine();
            try {
                const cpu = machine.newCpu();
                const { GPR, PREEMPT_AT } = machine.abi.cpu;
                const words = new Uint32Array(machine.memory.buffer);
                const bytes = new Uint8Array(words.buffer);
                const later = PARK + 0x20;
                const target = Uint8Array.of(0xc3);
                const source = Uint8Array.of(0x40, 0xeb, 0xdd); // inc eax; jmp PARK
                bytes.set(target, PARK);
                bytes.set(source, later);
                machine.loadModuleSync(compiler.translate(target, PARK, [], GUEST_LIMIT, false, opt), "target");
                machine.loadModuleSync(compiler.translate(source, later, [], GUEST_LIMIT, false, opt), "source");
                words[(cpu + GPR) >>> 2] = 10;
                words[(cpu + GPR + 16) >>> 2] = STACK;
                words[STACK >>> 2] = machine.stopAddress;
                words[machine.tickAddr >>> 2] = 100;
                words[(cpu + PREEMPT_AT) >>> 2] = 99;
                let resume = 0;
                machine.onPreempt = (_cpu, pc) => { resume = pc; return true; };
                expect(machine.run(cpu, later)).toBe(machine.yieldAddress);
                expect(resume).toBe(PARK);
                expect(words[(cpu + GPR) >>> 2]).toBe(11);
                expect(words[(cpu + GPR + 16) >>> 2]).toBe(STACK);
                words[(cpu + PREEMPT_AT) >>> 2] = 101;
                expect(machine.run(cpu, resume)).toBe(machine.stopAddress);
                expect(words[(cpu + GPR + 16) >>> 2]).toBe(STACK + 4);
            } finally { machine.dispose(); }
        });
    }

    test("yields at the scheduler's park without an ownership check and redispatches changed code", async () => {
        const { compiler, machine } = await fastMachine();
        try {
            const cpu = machine.newCpu();
            const { GPR, PREEMPT_AT } = machine.abi.cpu;
            const bytes = new Uint8Array(machine.memory.buffer);
            const state = new DataView(bytes.buffer);
            const write = (address: number, value: number) => state.setUint32(address, value, true);
            const instruction = Uint8Array.of(0xeb, 0xfe);
            bytes.set(instruction, PARK);
            machine.loadModuleSync(compiler.translate(instruction, PARK, [], GUEST_LIMIT), "park");
            const observed: Array<[number, number]> = [];
            const release = machine.setParkExit(PARK,
                (slot, pc) => observed.push([pc, state.getUint32(slot + GPR, true)]));
            write(cpu + GPR, 0x12345678);
            write(cpu + PREEMPT_AT, 0xffffffff);
            expect(machine.run(cpu, PARK)).toBe(machine.yieldAddress);
            expect(observed).toEqual([[PARK, 0x12345678]]);
            write(cpu + GPR, 7);
            expect(machine.run(cpu, PARK)).toBe(machine.yieldAddress);
            expect(observed).toEqual([[PARK, 0x12345678], [PARK, 7]]);
            const finished = Uint8Array.of(0xb8, 0x2a, 0, 0, 0, 0xc3); // mov eax,42; ret
            machine.codeEnd = () => PARK + finished.length;
            bytes.set(finished, PARK);
            write(cpu + GPR + 16, STACK);
            write(STACK, machine.stopAddress);
            expect(machine.run(cpu, PARK)).toBe(machine.stopAddress);
            expect(state.getUint32(cpu + GPR, true)).toBe(42);
            expect(observed).toHaveLength(2);
            release();
        } finally {
            machine.dispose();
        }
    });

    test("an oversized demand CFG retries with bounded input and preserves installed entries", async () => {
        const { compiler, machine } = await fastMachine();
        try {
            const cpu = machine.newCpu();
            const { GPR, PREEMPT_AT } = machine.abi.cpu;
            const bytes = new Uint8Array(machine.memory.buffer);
            const state = new DataView(bytes.buffer);
            const near = PARK + 12;
            const far = PARK + 0x1040;
            const known = [near, far];
            for (const pc of known) {
                bytes[pc] = 0xc3; // ret
                machine.loadModuleSync(compiler.translate(bytes.subarray(pc, pc + 1), pc, [], GUEST_LIMIT), "known");
            }
            const slots = known.map(pc => machine.lookup(pc));
            const attempts: Array<{ length: number; knownEntries: number[] }> = [];
            const translate = compiler.translate.bind(compiler);
            compiler.translate = (source, address, knownEntries, ...args) => {
                attempts.push({ length: source.length, knownEntries });
                if (source.length > 15) throw new WwtTranslationStackOverflow("Maximum call stack size exceeded");
                return translate(source, address, knownEntries, ...args);
            };
            machine.codeEnd = () => PARK + 0x2000;
            bytes.set([0xb8, 42, 0, 0, 0, 0xc3], PARK); // mov eax,42; ret
            state.setUint32(cpu + GPR + 16, STACK, true);
            state.setUint32(cpu + PREEMPT_AT, 0xffffffff, true);
            state.setUint32(STACK, machine.stopAddress, true);

            expect(machine.run(cpu, PARK)).toBe(machine.stopAddress);
            expect(state.getUint32(cpu + GPR, true)).toBe(42);
            expect(attempts).toEqual([
                { length: 0x2000, knownEntries: known },
                { length: 0x1000, knownEntries: [near] },
                { length: 15, knownEntries: [near] },
            ]);
            expect(known.map(pc => machine.lookup(pc))).toEqual(slots);
        } finally {
            machine.dispose();
        }
    });

    test("only installed demand entries contribute to CODE_WRITABLE", async () => {
        const { compiler, machine } = await fastMachine();
        try {
            const writable = PARK + 0x1000;
            const cpu = machine.newCpu();
            const otherCpu = machine.newCpu();
            const { CODE_WRITABLE, GPR, PREEMPT_AT } = machine.abi.cpu;
            const bytes = new Uint8Array(machine.memory.buffer);
            const state = new DataView(bytes.buffer);
            const codeBit = (address: number) => bytes[machine.storeMap + (address >>> 12)] & 1;
            const codeWritable = (slot: number) => state.getUint32(slot + CODE_WRITABLE, true);
            machine.canWriteCode = address => address === writable;
            machine.codeEnd = () => writable + 1;
            bytes[PARK] = bytes[writable] = 0xc3; // ret
            let sourceLength = 0;
            const translate = compiler.translate.bind(compiler);
            compiler.translate = (source, address, ...args) => {
                if (address === PARK) sourceLength = source.length;
                return translate(source, address, ...args);
            };
            const run = (address: number) => {
                state.setUint32(cpu + GPR + 16, STACK, true);
                state.setUint32(cpu + PREEMPT_AT, 0xffffffff, true);
                state.setUint32(STACK, machine.stopAddress, true);
                expect(machine.run(cpu, address)).toBe(machine.stopAddress);
            };

            run(PARK);
            expect(sourceLength).toBe(0x1001);
            expect(machine.lookup(PARK)).toBeGreaterThan(1);
            expect(machine.lookup(writable)).toBe(0);
            expect(codeBit(PARK)).toBe(1);
            expect(codeBit(writable)).toBe(0);
            expect(codeWritable(cpu)).toBe(0);
            expect(codeWritable(otherCpu)).toBe(0);

            run(writable);
            expect(machine.lookup(writable)).toBeGreaterThan(1);
            expect(codeBit(writable)).toBe(1);
            expect(codeWritable(cpu)).toBe(1);
            expect(codeWritable(otherCpu)).toBe(1);
        } finally {
            machine.dispose();
        }
    });

    test("checks a guest out-of-range access at its originating x86 PC", async () => {
        const { compiler, machine } = await fastMachine();
        try {
            const pc = PARK;
            const cpu = machine.newCpu();
            const bytes = Uint8Array.of(0xa1, 0, 0xf0, 0xff, 0xff, 0xc3); // mov eax,[0xfffff000]; ret
            new DataView(machine.memory.buffer).setUint32(cpu + machine.abi.cpu.PREEMPT_AT, 0xffffffff, true);
            machine.loadModuleSync(compiler.translate(bytes, pc, [], GUEST_LIMIT), "bounds");
            const faults: number[][] = [];
            machine.onFault = (_slot, code, eip, address) => {
                faults.push([code, eip, address]);
                return machine.stopAddress;
            };
            expect(machine.run(cpu, pc)).toBe(machine.stopAddress);
            expect(faults).toEqual([[machine.abi.fault.ACCESS_VIOLATION, pc, 0xfffff000]]);
            expect(() => machine.enableMmio()).toThrow("protected WWT");
        } finally {
            machine.dispose();
        }
    });
});
