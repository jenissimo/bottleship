import { describe, expect, test, spyOn } from "bun:test";
import { WinmmMci } from "../../src/worker/modules/winmm-mci";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

// Exercise the string command and real frame timers without needing a commercial movie
// or a codec. The decoder stand-in observes whether a timer can reach a playing device.
describe("MCI video resume after the paused frame timer expires", () => {
    test("restarts delivery once, while resume on a stopped device starts nothing", async () => {
        const mem = new Uint8Array(0x10000);
        const mci = new WinmmMci({
            readAnsiString: (ptr, max) => {
                let s = "";
                for (let i = 0; i < max && mem[ptr + i]; i++) s += String.fromCharCode(mem[ptr + i]!);
                return s;
            },
            writeAnsiString: () => true,
            readWideString: () => "",
            writeWideString: () => true,
        });
        const exports: Record<string, ThunkImplementation> = {};
        mci.registerExports(exports);
        const send = (command: string): number => {
            mem.fill(0, 0x100, 0x800);
            for (let i = 0; i < command.length; i++) mem[0x100 + i] = command.charCodeAt(i);
            return exports.mciSendStringA!({} as never, mem, [0x100, 0, 0, 0]) as number;
        };
        const internals = mci as unknown as {
            mciDevices: Map<number, { mode: string; videoEngineHandle?: number; videoPrerollComplete?: boolean; videoFrameTimer?: ReturnType<typeof setTimeout> }>;
            decodeMciVideoFrame(id: number): void;
            scheduleMciVideoFrame(device: unknown): void;
        };
        expect(send('open "synthetic.avi" type avivideo alias movie')).toBe(0);
        const device = [...internals.mciDevices.values()][0]!;
        device.videoEngineHandle = 7;
        device.videoPrerollComplete = false;
        device.mode = "playing";
        let deliveries = 0;
        const decode = spyOn(internals, "decodeMciVideoFrame").mockImplementation(() => {
            if (device.mode === "playing") deliveries++;
        });
        try {
            internals.scheduleMciVideoFrame(device);
            expect(send("pause movie")).toBe(0);
            await Bun.sleep(30);
            expect(deliveries).toBe(0);
            expect(send("resume movie")).toBe(0);
            expect(send("resume movie")).toBe(0);
            await Bun.sleep(30);
            expect(deliveries).toBe(1);
            device.mode = "stopped";
            expect(send("resume movie")).toBe(0);
            await Bun.sleep(30);
            expect(deliveries).toBe(1);
            expect(device.mode).toBe("stopped");
        } finally {
            if (device.videoFrameTimer) clearTimeout(device.videoFrameTimer);
            device.videoEngineHandle = undefined;
            send("close movie");
            decode.mockRestore();
        }
    });
});
