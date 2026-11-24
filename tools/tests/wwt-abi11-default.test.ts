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
    }

    test("exits the scheduler's park with current registers and redispatches changed code", async () => {
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
            let owner = true;
            const release = machine.setParkExit(PARK, pc => owner && pc === PARK,
                (slot, pc) => observed.push([pc, state.getUint32(slot + GPR, true)]));
            write(cpu + GPR, 0x12345678);
            write(cpu + PREEMPT_AT, 0xffffffff);
            expect(machine.run(cpu, PARK)).toBe(machine.yieldAddress);
            expect(observed).toEqual([[PARK, 0x12345678]]);
            owner = false;
            const finished = Uint8Array.of(0xb8, 0x2a, 0, 0, 0, 0xc3); // mov eax,42; ret
            machine.codeEnd = () => PARK + finished.length;
            bytes.set(finished, PARK);
            write(cpu + GPR + 16, STACK);
            write(STACK, machine.stopAddress);
            expect(machine.run(cpu, PARK)).toBe(machine.stopAddress);
            expect(state.getUint32(cpu + GPR, true)).toBe(42);
            expect(observed).toHaveLength(1);
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
