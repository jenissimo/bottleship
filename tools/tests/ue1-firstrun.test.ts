/**
 * Unit tests for the generic Unreal Engine 1 first-run support (ue1-firstrun.ts).
 *
 * Covers the two pure pieces wired into boot + CreateFile*:
 *  - pinUe1RenderDevice: ensures [Engine.Engine] selects D3DDrv (add section, add
 *    missing keys, replace SoftDrv/Null/etc., idempotent, preserves everything else).
 *  - detectUe1: UE1 iff System/Core+Engine packages (DLLs or .u) are present.
 *  - classifyUe1FirstRunFile: which open requests we react to.
 */
import { describe, expect, test } from "bun:test";
import {
    detectUe1,
    detectUe2PcPackages,
    pinUe1RenderDevice,
    pinUe2ForceFeedbackManager,
    pinUe2PcPackagePath,
    pinUeEngineIni,
    classifyUe1FirstRunFile,
    isUe1RenderProbeCommandLine,
    dirOfWindowsPath,
    baseOfWindowsPath,
    UE1_RENDER_DEVICE,
    UE2_PC_PACKAGES_PATH,
} from "../../src/worker/runtime/filesystem/ue1-firstrun";

const D3D = UE1_RENDER_DEVICE; // "D3DDrv.D3DRenderDevice"

describe("pinUe1RenderDevice", () => {
    test("adds [Engine.Engine] section + all three keys when missing", () => {
        const out = pinUe1RenderDevice("[URL]\nProtocol=unreal\n");
        expect(out).toContain("[Engine.Engine]");
        expect(out).toContain(`GameRenderDevice=${D3D}`);
        expect(out).toContain(`WindowedRenderDevice=${D3D}`);
        expect(out).toContain(`RenderDevice=${D3D}`);
        // Original section preserved
        expect(out).toContain("[URL]");
        expect(out).toContain("Protocol=unreal");
    });

    test("replaces a SoftDrv render device with D3D", () => {
        const ini = [
            "[Engine.Engine]",
            "GameRenderDevice=SoftDrv.SoftwareRenderDevice",
            "WindowedRenderDevice=SoftDrv.SoftwareRenderDevice",
            "Console=Engine.Console",
        ].join("\n");
        const out = pinUe1RenderDevice(ini);
        expect(out).not.toContain("SoftDrv.SoftwareRenderDevice");
        expect(out).toContain(`GameRenderDevice=${D3D}`);
        expect(out).toContain(`WindowedRenderDevice=${D3D}`);
        // The key that was absent is added
        expect(out).toContain(`RenderDevice=${D3D}`);
        // Unrelated key preserved
        expect(out).toContain("Console=Engine.Console");
    });

    test("replaces Engine.NullRenderDevice", () => {
        const ini = "[Engine.Engine]\nRenderDevice=Engine.NullRenderDevice\n";
        const out = pinUe1RenderDevice(ini);
        expect(out).not.toContain("Engine.NullRenderDevice");
        expect(out).toContain(`RenderDevice=${D3D}`);
    });

    test("is idempotent — already-pinned config is unchanged", () => {
        const ini = [
            "[Engine.Engine]",
            `GameRenderDevice=${D3D}`,
            `WindowedRenderDevice=${D3D}`,
            `RenderDevice=${D3D}`,
        ].join("\n");
        const once = pinUe1RenderDevice(ini);
        const twice = pinUe1RenderDevice(once);
        expect(once).toBe(twice);
        // No duplicate keys introduced — each of the three keys appears exactly once.
        expect(once.match(/^GameRenderDevice=/gm)?.length).toBe(1);
        expect(once.match(/^WindowedRenderDevice=/gm)?.length).toBe(1);
        expect(once.match(/^RenderDevice=/gm)?.length).toBe(1);
    });

    test("preserves other sections, keys, comments and blank lines verbatim", () => {
        const ini = [
            "; top comment",
            "[Engine.GameEngine]",
            "CacheSizeMegs=32",
            "",
            "[Engine.Engine]",
            "GameRenderDevice=SoftDrv.SoftwareRenderDevice",
            "AudioDevice=Galaxy.GalaxyAudioSubsystem",
            "",
            "[WinDrv.WindowsClient]",
            "WindowedViewportX=640",
        ].join("\n");
        const out = pinUe1RenderDevice(ini);
        expect(out).toContain("; top comment");
        expect(out).toContain("[Engine.GameEngine]");
        expect(out).toContain("CacheSizeMegs=32");
        expect(out).toContain("AudioDevice=Galaxy.GalaxyAudioSubsystem");
        expect(out).toContain("[WinDrv.WindowsClient]");
        expect(out).toContain("WindowedViewportX=640");
        expect(out).toContain(`GameRenderDevice=${D3D}`);
        expect(out).not.toContain("SoftDrv");
    });

    test("preserves CRLF line endings when the source uses them", () => {
        const ini = "[Engine.Engine]\r\nGameRenderDevice=SoftDrv.SoftwareRenderDevice\r\n";
        const out = pinUe1RenderDevice(ini);
        expect(out).toContain("\r\n");
        expect(out).toContain(`GameRenderDevice=${D3D}`);
    });

    test("matches [Engine.Engine] case-insensitively", () => {
        const ini = "[engine.engine]\nGameRenderDevice=SoftDrv.SoftwareRenderDevice\n";
        const out = pinUe1RenderDevice(ini);
        expect(out).not.toContain("SoftDrv");
        expect(out).toContain(`GameRenderDevice=${D3D}`);
        // Did NOT append a second [Engine.Engine]
        expect(out.match(/\[engine\.engine\]/gi)?.length).toBe(1);
    });
});

describe("pinUe2ForceFeedbackManager", () => {
    const xiiiEngine = [
        "[Engine.Engine]",
        "ViewportManager=WinDrv.WindowsClient",
        "RenderDevice=D3DDrv.D3DRenderDevice",
    ].join("\n");

    test("does NOT inject ForceFeedbackManager when absent (retail XIII ships none)", () => {
        const out = pinUe2ForceFeedbackManager(xiiiEngine);
        expect(out).toBe(xiiiEngine);
        expect(out.toLowerCase()).not.toContain("forcefeedbackmanager=");
    });

    test("strips a previously-injected abstract-base line (self-heal)", () => {
        const ini = `${xiiiEngine}\nForceFeedbackManager=Engine.ForceFeedbackManager\n`;
        const out = pinUe2ForceFeedbackManager(ini);
        expect(out.toLowerCase()).not.toContain("forcefeedbackmanager=");
        expect(out).toContain("ViewportManager=WinDrv.WindowsClient");
    });

    test("strips a previously-injected controller line (self-heal)", () => {
        const ini = `${xiiiEngine}\nForceFeedbackManager=Engine.ForceFeedbackController\n`;
        expect(pinUe2ForceFeedbackManager(ini).toLowerCase()).not.toContain("forcefeedbackmanager=");
    });

    test("leaves a real game's own ForceFeedbackManager value untouched", () => {
        const ini = `${xiiiEngine}\nForceFeedbackManager=WinDrv.WindowsForceFeedbackManager\n`;
        expect(pinUe2ForceFeedbackManager(ini)).toBe(ini);
    });

    test("no-op without [Engine.Engine]", () => {
        const ini = "[URL]\nProtocol=unreal\n";
        expect(pinUe2ForceFeedbackManager(ini)).toBe(ini);
    });
});

describe("pinUe2PcPackagePath", () => {
    test("adds System\\PC package path under [Core.System]", () => {
        const ini = [
            "[Core.System]",
            "Paths=..\\System\\*.u",
            "CacheSizeMegs=1",
        ].join("\n");
        const out = pinUe2PcPackagePath(ini);
        expect(out).toContain(`Paths=${UE2_PC_PACKAGES_PATH}`);
        expect(out.indexOf("Paths=..\\System\\*.u")).toBeLessThan(out.indexOf(`Paths=${UE2_PC_PACKAGES_PATH}`));
    });

    test("no-op when PC path already present", () => {
        const ini = `[Core.System]\nPaths=${UE2_PC_PACKAGES_PATH}\n`;
        expect(pinUe2PcPackagePath(ini)).toBe(ini);
    });
});

describe("pinUeEngineIni", () => {
    test("pins render device and PC paths, and strips an injected abstract FF base", () => {
        const ini = [
            "[Engine.Engine]",
            "ViewportManager=WinDrv.WindowsClient",
            "GameRenderDevice=SoftDrv.SoftwareRenderDevice",
            "ForceFeedbackManager=Engine.ForceFeedbackManager",
            "[Core.System]",
            "Paths=..\\System\\*.u",
        ].join("\n");
        const out = pinUeEngineIni(ini, { hasPcPackages: true });
        expect(out).toContain(`GameRenderDevice=${D3D}`);
        expect(out.toLowerCase()).not.toContain("forcefeedbackmanager=");
        expect(out).toContain(`Paths=${UE2_PC_PACKAGES_PATH}`);
    });
});

describe("detectUe2PcPackages", () => {
    test("true when System\\PC\\gui.u exists", () => {
        const exists = (p: string) => p.toLowerCase() === "c:\\system\\pc\\gui.u";
        expect(detectUe2PcPackages(exists)).toBe(true);
    });
});

describe("detectUe1", () => {
    const mk = (files: string[]) => {
        const set = new Set(files.map((f) => f.toLowerCase()));
        return (p: string) => set.has(p.toLowerCase());
    };

    test("true when System\\Core.dll + Engine.dll present", () => {
        expect(detectUe1(mk(["C:\\System\\Core.dll", "C:\\System\\Engine.dll"]))).toBe(true);
    });

    test("true when System\\Core.u + Engine.u present", () => {
        expect(detectUe1(mk(["C:\\System\\Core.u", "C:\\System\\Engine.u"]))).toBe(true);
    });

    test("false for a non-UE1 game (no engine packages)", () => {
        expect(detectUe1(mk(["C:\\Game\\game.exe", "C:\\Game\\data.pak"]))).toBe(false);
    });

    test("false with only one of the pair", () => {
        expect(detectUe1(mk(["C:\\System\\Core.dll"]))).toBe(false);
        expect(detectUe1(mk(["C:\\System\\Engine.u"]))).toBe(false);
    });

    test("case-insensitive on the bundle's file names", () => {
        expect(detectUe1(mk(["c:\\system\\core.dll", "c:\\system\\engine.dll"]))).toBe(true);
    });
});

describe("classifyUe1FirstRunFile", () => {
    test("Detected.ini / Detected.log → 'detected' regardless of dir", () => {
        expect(classifyUe1FirstRunFile("Detected.ini", false)).toBe("detected");
        expect(classifyUe1FirstRunFile("detected.log", false)).toBe("detected");
        expect(classifyUe1FirstRunFile("DETECTED.INI", true)).toBe("detected");
    });

    test("User.ini in the user dir → 'user-ini'", () => {
        expect(classifyUe1FirstRunFile("User.ini", true)).toBe("user-ini");
    });

    test("other *.ini in the user dir → 'ini'", () => {
        expect(classifyUe1FirstRunFile("HP.ini", true)).toBe("ini");
        expect(classifyUe1FirstRunFile("Unreal.ini", true)).toBe("ini");
    });

    test("*.ini OUTSIDE the user dir → null (don't seed arbitrary inis)", () => {
        expect(classifyUe1FirstRunFile("HP.ini", false)).toBeNull();
        expect(classifyUe1FirstRunFile("User.ini", false)).toBeNull();
    });

    test("non-ini, non-detected → null", () => {
        expect(classifyUe1FirstRunFile("Core.dll", true)).toBeNull();
        expect(classifyUe1FirstRunFile("save0.usa", true)).toBeNull();
    });
});

describe("isUe1RenderProbeCommandLine", () => {
    test("recognizes the testrendev probe (HP: Philosopher's Stone demo, verbatim)", () => {
        expect(isUe1RenderProbeCommandLine("testrendev=D3DDrv.D3DRenderDevice log=Detected.log")).toBe(true);
        expect(isUe1RenderProbeCommandLine("HPDemo.exe testrendev=SoftDrv.SoftwareRenderDevice")).toBe(true);
        expect(isUe1RenderProbeCommandLine("TESTRENDEV = OpenGLDrv.OpenGLRenderDevice")).toBe(true);
    });

    test("still recognizes the older -b false browser probe", () => {
        expect(isUe1RenderProbeCommandLine("UnrealTournament.exe -b false")).toBe(true);
    });

    test("a real relaunch is NOT a probe — it must stay eligible for self re-exec", () => {
        expect(isUe1RenderProbeCommandLine("PrivetDr.unr -SAVESLOT=1")).toBe(false);
        expect(isUe1RenderProbeCommandLine("")).toBe(false);
        // Substring of a longer token: not the probe switch.
        expect(isUe1RenderProbeCommandLine("map=notestrendev=x")).toBe(false);
        expect(isUe1RenderProbeCommandLine("-b true")).toBe(false);
    });
});

describe("path helpers", () => {
    test("dirOfWindowsPath / baseOfWindowsPath", () => {
        expect(dirOfWindowsPath("C:\\My Documents\\Hp demo\\Detected.ini")).toBe("C:\\My Documents\\Hp demo");
        expect(baseOfWindowsPath("C:\\My Documents\\Hp demo\\Detected.ini")).toBe("Detected.ini");
        expect(dirOfWindowsPath("C:/System/HP.ini")).toBe("C:\\System");
        expect(baseOfWindowsPath("HP.ini")).toBe("HP.ini");
    });
});

// Why the caller must read the config to COMPLETION before pinning: fed an empty string
// (what a short read decodes to), the pin cannot tell "no config" from "config we failed to
// read" and synthesizes a bare stub. Written into the CoW overlay it shadows the bundle's
// factory config on every later boot, and the engine loses [Core.System] — no Language, so
// it asks for an unsuffixed `Splash.bmp` and dies in InitEngine. The guard lives in
// pinGuestEngineIni (emulator.worker.ts); this pins down what it is guarding against.
describe("pinUeEngineIni on an empty config — the short-read trap", () => {
    test("an empty source yields a stub with NO [Core.System]", () => {
        const stub = pinUeEngineIni("", {});
        expect(stub).toContain("[Engine.Engine]");
        expect(stub).toContain(UE1_RENDER_DEVICE);
        expect(/\[Core\.System\]/i.test(stub)).toBe(false);   // Language/Paths are gone
        expect(stub.length).toBe(136);                        // the exact byte count observed
    });

    test("a real config keeps [Core.System] verbatim while the device is pinned", () => {
        const factory = [
            "[Core.System]",
            "Paths=..\System\*.u",
            "Language=int",
            "",
            "[Engine.Engine]",
            "GameRenderDevice=SoftDrv.SoftwareRenderDevice",
        ].join("\r\n");
        const pinned = pinUeEngineIni(factory, {});
        expect(pinned).toContain("Language=int");
        expect(pinned).toContain("Paths=..\System\*.u");
        expect(pinned).toContain(`GameRenderDevice=${UE1_RENDER_DEVICE}`);
        expect(pinned).not.toContain("SoftDrv.SoftwareRenderDevice");
    });
});
