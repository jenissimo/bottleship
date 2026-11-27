import { expect, test } from "bun:test";
import { BottleShipMachine } from "../../src/worker/wwt/machine";
import { WwtCompiler } from "../../src/worker/wwt/translator";

const GUEST_LIMIT = 4 << 20;
const CODE = 0x100000;
const STACK = 0x18000;

test("a demand window stops at zero padding after a call that does not return", async () => {
    const file = Bun.file(new URL("../../public/wwt-provider/wwt_abi11.wasm", import.meta.url));
    const compiler = await WwtCompiler.fromBytes(await file.arrayBuffer(), true);
    const machine = new BottleShipMachine(compiler, GUEST_LIMIT, 0x40000, 0);
    await machine.init();
    const cpu = machine.newCpu();
    const view = new DataView(machine.memory.buffer);
    const ram = new Uint8Array(machine.memory.buffer);
    const { GPR, PREEMPT_AT } = machine.abi.cpu;
    ram.fill(0, CODE, CODE + 0x41000);
    ram.set([0x85, 0xc0, 0x75, 0x01, 0xc3, 0xe8, 0xf6, 0xff, 0xff, 0xff], CODE);
    view.setUint32(cpu + GPR, 0, true);
    view.setUint32(cpu + GPR + 4 * 4, STACK, true);
    view.setUint32(STACK, machine.stopAddress, true);
    view.setUint32(cpu + PREEMPT_AT, 0x70000000, true);
    expect(machine.run(cpu, CODE)).toBe(machine.stopAddress);
    expect(machine.translationStats.wasmBytes).toBeLessThan(1 << 20);
});
