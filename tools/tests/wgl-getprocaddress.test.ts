/**
 * wglGetProcAddress must resolve against the SAME registry kernel32's
 * GetProcAddress uses (the ThunkGenerator's stub table), not ModuleRegistry.
 *
 * HLE modules have no PE image, so ModuleRegistry knows nothing about them —
 * a title that ships no guest DLLs has an empty ModuleRegistry and every
 * wglGetProcAddress then returns NULL. Engines resolve extension entry points
 * that way exclusively, and treat "extension advertised by glGetString but
 * entry point NULL" as fatal, so the two lookups disagreeing is a hard stop
 * rather than a degraded-quality path.
 *
 * The two DO differ on one point, deliberately: GetProcAddress may hand back a stub for
 * a declared-but-unimplemented export, whereas for wglGetProcAddress NULL is the
 * documented "this extension is absent" answer — a non-NULL pointer tells the engine the
 * extension is present, so it calls it and believes the garbage return.
 *
 * Contract mirrored from the WGL spec / Wine's wglGetProcAddress:
 *   - no current context            -> NULL
 *   - name not provided             -> NULL
 *   - declared but not implemented  -> NULL
 *   - provided entry point          -> the callable stub address
 */

import { describe, expect, test } from "bun:test";
import { createWglExports } from "../../src/worker/modules/opengl32/wgl";
import { resolveHleExportAddress } from "../../src/worker/core/thunking/export-resolver";

const NAME_PTR = 0x1000;

/**
 * ThunkGenerator + dispatcher stand-in: the lookups the early-return path uses, plus the
 * address -> stub -> registered-handler introspection wglGetProcAddress gates on.
 * `unimplemented` names resolve to an address whose functionId has no handler.
 */
function makeDispatcher(stubs: Record<string, number>, unimplemented: readonly string[] = []) {
    const lookups: string[] = [];
    const dead = new Set<number>();
    for (const name of unimplemented) {
        const addr = stubs[`opengl32:${name}`.toLowerCase()] ?? stubs[name.toLowerCase()];
        if (addr !== undefined) dead.add(addr >>> 0);
    }
    return {
        lookups,
        thunkGenerator: {
            getDataExportAddress: () => undefined,
            getExportAddress: (key: string) => {
                lookups.push(key);
                return stubs[key.toLowerCase()];
            },
            getStubByAddress: (addr: number) => ({ functionId: addr >>> 0 }),
        },
        getImplementationInfo: (functionId: number) =>
            dead.has(functionId >>> 0) ? null : { arity: 3, argCount: 1 },
    };
}

function makeHarness(stubs: Record<string, number>, unimplemented: readonly string[] = []) {
    const mem = new Uint8Array(0x8000);
    const dispatcher = makeDispatcher(stubs, unimplemented);
    // ctx.presenter left undefined so wglMakeCurrent stays free of System singletons.
    const ctx: any = {
        process: { getCurrentMemory: () => mem, dispatcher },
        stringCache: new Map(),
    };
    const api = createWglExports(ctx);
    const call = (name: string, ...args: number[]) =>
        (api[name]!({ esp: 0 } as any, mem, args as any) as number) >>> 0;

    const writeName = (s: string) => {
        for (let i = 0; i < s.length; i++) mem[NAME_PTR + i] = s.charCodeAt(i);
        mem[NAME_PTR + s.length] = 0;
        return NAME_PTR;
    };
    const gpa = (s: string) => call("wglGetProcAddress", writeName(s));
    const makeCurrent = () => {
        const hglrc = call("wglCreateContext", 0xdc);
        expect(call("wglMakeCurrent", 0xdc, hglrc)).toBe(1);
        return hglrc;
    };
    return { mem, call, gpa, makeCurrent, dispatcher };
}

describe("wglGetProcAddress", () => {
    test("returns NULL when there is no current context", () => {
        const h = makeHarness({ "opengl32:gllockarraysext": 0x21000010 });
        expect(h.gpa("glLockArraysEXT")).toBe(0);
    });

    test("resolves an extension entry point through the thunk registry", () => {
        const h = makeHarness({
            "opengl32:gllockarraysext": 0x21000010,
            "opengl32:glunlockarraysext": 0x21000020,
        });
        h.makeCurrent();
        expect(h.gpa("glLockArraysEXT")).toBe(0x21000010);
        expect(h.gpa("glUnlockArraysEXT")).toBe(0x21000020);
        // Qualified "dll:name" is tried first — that is the key GetProcAddress uses.
        expect(h.dispatcher.lookups).toContain("opengl32:glLockArraysEXT");
    });

    test("GL_EXT_compiled_vertex_array entry points are resolvable whenever the extension is advertised", () => {
        // The engine-fatal case: glGetString(GL_EXTENSIONS) promises the extension,
        // so both entry points must be handed out or the promise is a lie.
        const advertised = "GL_ARB_multitexture GL_EXT_compiled_vertex_array";
        const h = makeHarness({
            "opengl32:gllockarraysext": 0x21000010,
            "opengl32:glunlockarraysext": 0x21000020,
            "opengl32:glactivetexturearb": 0x21000030,
        });
        h.makeCurrent();
        if (advertised.includes("GL_EXT_compiled_vertex_array")) {
            expect(h.gpa("glLockArraysEXT")).not.toBe(0);
            expect(h.gpa("glUnlockArraysEXT")).not.toBe(0);
        }
        if (advertised.includes("GL_ARB_multitexture")) {
            expect(h.gpa("glActiveTextureARB")).not.toBe(0);
        }
    });

    test("falls back to the core function for an ARB alias we do not export directly", () => {
        const h = makeHarness({ "opengl32:glmultitexcoord1f": 0x21000040 });
        h.makeCurrent();
        expect(h.gpa("glMultiTexCoord1fARB")).toBe(0x21000040);
    });

    test("returns NULL for an entry point we genuinely do not provide", () => {
        const h = makeHarness({});
        h.makeCurrent();
        expect(h.gpa("glSomethingWeNeverImplemented")).toBe(0);
    });

    test("an empty name is NULL, never a stray pointer", () => {
        const h = makeHarness({ "opengl32:": 0x21000050 });
        h.makeCurrent();
        expect(h.gpa("")).toBe(0);
    });

    // The API descriptor carrying a signature only means the name is DECLARED. Handing
    // its stub out claims the extension exists; the guest then calls it and takes the
    // untouched-out-param garbage as a real answer.
    test("returns NULL for a declared entry point with no registered handler", () => {
        const h = makeHarness(
            { "opengl32:glsomethingdeclaredonly": 0x21000060 },
            ["glSomethingDeclaredOnly"],
        );
        h.makeCurrent();
        expect(h.gpa("glSomethingDeclaredOnly")).toBe(0);
    });

    test("an ARB alias of an unimplemented core function is NULL too", () => {
        const h = makeHarness(
            { "opengl32:glmultitexcoord1f": 0x21000070 },
            ["glMultiTexCoord1f"],
        );
        h.makeCurrent();
        expect(h.gpa("glMultiTexCoord1fARB")).toBe(0);
    });
});

describe("resolveHleExportAddress", () => {
    test("prefers the qualified dll:name key, then the bare name", () => {
        const qualified = makeDispatcher({ "opengl32:glgetstring": 0x2100aaaa });
        expect(resolveHleExportAddress(qualified, "opengl32", "glGetString")).toBe(0x2100aaaa);

        const bare = makeDispatcher({ "glgetstring": 0x2100bbbb });
        expect(resolveHleExportAddress(bare, "opengl32", "glGetString")).toBe(0x2100bbbb);
    });

    test("returns 0 without a dispatcher rather than inventing a pointer", () => {
        expect(resolveHleExportAddress(undefined, "opengl32", "glGetString")).toBe(0);
        expect(resolveHleExportAddress({}, "opengl32", "glGetString")).toBe(0);
    });

    test("data exports win over code stubs (they are variables, not callables)", () => {
        const dispatcher = {
            thunkGenerator: {
                getDataExportAddress: (_dll: string, name: string) =>
                    name === "_acmdln" ? 0x00401234 : undefined,
                getExportAddress: () => 0x21000000,
            },
        };
        expect(resolveHleExportAddress(dispatcher, "msvcrt", "_acmdln")).toBe(0x00401234);
    });
});
