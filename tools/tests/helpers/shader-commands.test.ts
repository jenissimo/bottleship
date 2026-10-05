import { describe, expect, test } from "bun:test";
import { System } from "../../../src/worker/core/system";
import { registerShaderCommands } from "../../../src/worker/harness/cmds/shader";

type Handler = (args: unknown[], ctx: unknown) => unknown | Promise<unknown>;

class StubHarnessService {
    readonly handlers = new Map<string, Handler>();
    register(name: string, handler: Handler): void {
        this.handlers.set(name, handler);
    }
}

describe("shader harness commands", () => {
    test("d3d9Census exposes the refusal and approximation ledgers", () => {
        const service = new StubHarnessService();
        registerShaderCommands(service as never);
        // `reset` reports the window it closes, so the first call hands back whatever earlier
        // tests in this process recorded; the empty ledgers are the SECOND call's.
        service.handlers.get("d3d9Census")!([{ reset: true }], {});
        const result = service.handlers.get("d3d9Census")!([{ reset: true }], {});
        const census = result as {
            dropDraws: Record<string, number>;
            ffpUnimplemented: Record<string, number>;
            approximated: Record<string, number>;
            formatSupport: {
                refusedFormat: Record<string, number>;
                refusedFourCC: Record<string, number>;
            };
            shaderUnsupported: number;
        };
        expect(census.dropDraws).toEqual({});
        expect(census.ffpUnimplemented).toEqual({});
        expect(census.approximated).toEqual({});
        expect(census.formatSupport.refusedFormat).toEqual({});
        expect(census.formatSupport.refusedFourCC).toEqual({});
        expect(census.shaderUnsupported).toBe(0);

        const drops = service.handlers.get("dropDraws")!([{ reset: true }], {}) as {
            dropDraws: Record<string, number>;
        };
        expect(drops.dropDraws).toEqual({});
    });

    test("wgslCheck returns non-empty normalized diagnostics for a broken module", async () => {
        const system = System.getInstance();
        const previous = system.services.render.getBackend();
        const fakeDevice = {
            createShaderModule: ({ code }: { code: string }) => ({
                getCompilationInfo: async () => ({
                    messages: code.includes("broken") ? [{
                        type: "error", message: "expected ';'", lineNum: 1, linePos: 4, offset: 3, length: 2,
                    }] : [],
                }),
            }),
        };
        const fakeBackend = { kind: "webgpu", getDevice: () => fakeDevice };
        system.services.render.setBackend(fakeBackend as never);
        try {
            const service = new StubHarnessService();
            registerShaderCommands(service as never);
            const result = await service.handlers.get("wgslCheck")!([{ wgsl: "fn broken(" }], {});
            const diagnostics = result as { ok: boolean; messages: Array<{ type: string; message: string }> };
            expect(diagnostics.ok).toBe(false);
            expect(diagnostics.messages.length).toBeGreaterThan(0);
            expect(diagnostics.messages[0]?.type).toBe("error");
            expect(diagnostics.messages[0]?.message).toContain("expected");
        } finally {
            system.services.render.setBackend(previous as never);
        }
    });
});
