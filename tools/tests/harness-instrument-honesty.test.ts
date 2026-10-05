/**
 * The harness's own instruments, held to the rule they exist to enforce: an instrument that
 * cannot express its failure reports a plausible number for a question it never asked.
 * Each case here is a defect that shipped as a confident zero / vacuous pass.
 */
import { test, expect } from "bun:test";
import { eipBreaks } from "../../src/worker/harness/eip-breaks";
import { collectShaderCensus, censusComplete } from "../../src/worker/harness/shader-census";
import { registerShaderCommands } from "../../src/worker/harness/cmds/shader";
import { registerFsCommands } from "../../src/worker/harness/cmds/fs";
import { devices as d3d9Devices } from "../../src/worker/modules/d3d9/shared-state";
import { d3d9DropDraw, resetD3D9Perf } from "../../src/worker/modules/d3d9/d3d9-perf";
import { vfsIoCensus } from "../../src/worker/runtime/filesystem/vfs";

class StubService {
    readonly handlers = new Map<string, (args: unknown[], ctx: unknown) => unknown>();
    register(name: string, handler: (args: unknown[], ctx: unknown) => unknown): void {
        this.handlers.set(name, handler);
    }
}

test("a re-wrapped console.error counts each breakpoint hit once", () => {
    let hits = 0;
    eipBreaks.arm(0x401000, { once: false, pause: false, callsite: false, onHit: () => { hits++; } });
    const previous = console.error;
    console.error = (...a: unknown[]) => (previous as (...args: unknown[]) => void)(...a);
    eipBreaks.arm(0x401004, { once: false, pause: false, callsite: false });
    console.error("[DBG] eip=0x00401000 <BP> x");
    eipBreaks.clear();
    console.error = previous;
    expect(hits).toBe(1);
});

test("a shader census with no device, or a device that threw, is not complete", () => {
    expect(censusComplete(collectShaderCensus(false))).toBe(false);
    d3d9Devices.set(0xdead, { shaderInstrumentationSnapshot: () => { throw new Error("torn down"); } } as never);
    const collected = collectShaderCensus(false);
    d3d9Devices.delete(0xdead);
    expect(collected.deviceCount).toBe(1);
    expect(collected.snapshotFailures).toBe(1);
    expect(censusComplete(collected)).toBe(false);
});

test("dropDraws({reset}) reports the window it closes", () => {
    const svc = new StubService();
    registerShaderCommands(svc as never);
    resetD3D9Perf();
    d3d9DropDraw("no-vertex-buffer");
    expect((svc.handlers.get("dropDraws")!([{ reset: true }], {}) as { dropDraws: Record<string, number> }).dropDraws)
        .toEqual({ "no-vertex-buffer": 1 });
    expect((svc.handlers.get("dropDraws")!([{}], {}) as { dropDraws: Record<string, number> }).dropDraws).toEqual({});
});

test("fsIoReport does not answer armsSumOk over an empty census", () => {
    const svc = new StubService();
    registerFsCommands(svc as never);
    vfsIoCensus.reset();
    const empty = svc.handlers.get("fsIoReport")!([{}], {}) as { reads: number; armsSumOk: boolean | null; enabled: boolean };
    expect(empty.reads).toBe(0);
    expect(empty.armsSumOk).toBeNull();
    expect(empty.enabled).toBe(true);
    vfsIoCensus.reads = 2;
    vfsIoCensus.hitRomCache = 2;
    expect((svc.handlers.get("fsIoReport")!([{}], {}) as { armsSumOk: boolean | null }).armsSumOk).toBe(true);
    vfsIoCensus.reset();
});
