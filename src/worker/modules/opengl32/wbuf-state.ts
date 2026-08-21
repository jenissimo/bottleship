/**
 * Tier-0 write-buffer coverage for the vertex-array-era GL entrypoints.
 *
 * immediate.ts covers glBegin plus the glVertex / glColor / glTexCoord family — the calls an
 * immediate-mode title makes. A title that draws from client arrays never touches
 * any of them and pays a full OUT trap for every state set, bind and array pointer.
 *
 * An entrypoint belongs on the ring when ALL of:
 *   - it returns nothing the guest reads,
 *   - every argument is by value (a pointer argument is fine only when GL itself
 *     defers the dereference — the gl*Pointer family records the pointer and the
 *     draw reads it), and
 *   - its only effect is mutating our GL context.
 * Everything else keeps trapping. Ordering is not at risk: the ring is FIFO and
 * handlePortWrite drains it before ANY trapping handler runs, so a draw, a glGet*
 * or a SwapBuffers always observes every buffered call that preceded it.
 */

import { ThunkImplementation, WriteBufHandler, X86Context } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { APIRegistry } from "../../core/api-registry";

/**
 * [export name, DWORD count the caller pushes]. The count must match
 * `src/worker/api/opengl32.api.ts` — a GLdouble occupies two DWORDs — because it
 * sizes both the ring entry and the trampoline's RET N.
 *
 * Deliberately absent, with the reason:
 *   glLoadIdentity / glUnlockArraysEXT  — zero args; the trampoline table starts at one.
 *   glLoadMatrix* / glMultMatrix* / gl*fv — GL dereferences the pointer AT CALL TIME, so a
 *                                        deferred read can see a scratch the guest reused.
 *   glOrtho / glFrustum                 — six GLdoubles = 12 DWORDs, past the 8-arg trampolines.
 *   glViewport / glClear                — append to the command stream, not just context state.
 *   glGet* / glIsEnabled / glGetError / glReadPixels — the guest reads the result.
 *   glTexImage* / glTexSubImage* / glCompressedTex* — variable-size guest data.
 *   glDraw* / glEnd / glArrayElement / SwapBuffers / display-list control — flush points.
 */
const RING_FUNCTIONS: ReadonlyArray<readonly [string, number]> = [
    // --- pure state setters ---
    ["glEnable", 1], ["glDisable", 1],
    ["glShadeModel", 1], ["glCullFace", 1], ["glFrontFace", 1],
    ["glDepthFunc", 1], ["glDepthMask", 1],
    ["glStencilMask", 1], ["glLogicOp", 1], ["glClearStencil", 1],
    ["glLineWidth", 1], ["glPointSize", 1], ["glMatrixMode", 1],
    ["glActiveTexture", 1], ["glClientActiveTexture", 1],
    ["glActiveTextureARB", 1], ["glClientActiveTextureARB", 1],

    ["glBlendFunc", 2], ["glAlphaFunc", 2], ["glHint", 2],
    ["glPolygonMode", 2], ["glPolygonOffset", 2],
    ["glPixelStorei", 2], ["glPixelStoref", 2], ["glPixelZoom", 2],
    ["glColorMaterial", 2], ["glLineStipple", 2],
    ["glFogf", 2], ["glFogi", 2], ["glClearDepth", 2],

    ["glStencilFunc", 3], ["glStencilOp", 3],
    ["glTexEnvi", 3], ["glTexEnvf", 3], ["glTexGeni", 3], ["glTexGenf", 3],
    ["glLightf", 3], ["glLighti", 3], ["glMaterialf", 3], ["glMateriali", 3],
    ["glTexParameteri", 3], ["glTexParameterf", 3],

    ["glColorMask", 4], ["glScissor", 4], ["glClearColor", 4], ["glDepthRange", 4],

    // --- binds and client-array specification ---
    ["glBindTexture", 2],
    ["glEnableClientState", 1], ["glDisableClientState", 1],
    ["glNormalPointer", 3], ["glIndexPointer", 3], ["glEdgeFlagPointer", 2],
    ["glVertexPointer", 4], ["glColorPointer", 4], ["glTexCoordPointer", 4],
    ["glInterleavedArrays", 3],
    ["glLockArraysEXT", 2],
];

/**
 * Patch the listed stubs to the JMP trampoline and drain them through the module's
 * OWN export table. Reusing the export (not a second copy of the logic) is what keeps
 * the ring path and the trap path from drifting, and it inherits index.ts's
 * display-list wrapper for free, so GL_COMPILE / GL_COMPILE_AND_EXECUTE recording
 * still sees every buffered call.
 *
 * `exports` must be the WRAPPED table — call this after index.ts installs the wrapper.
 * Kill-switch `globalThis.__noGlStateWbuf` returns every listed entrypoint to the OUT
 * trap for a clean A/B.
 */
export function registerWriteBufferGLStateFunctions(
    dispatcher: any,
    exports: Record<string, ThunkImplementation>,
): void {
    if (typeof dispatcher?.registerWriteBufferFunction !== "function") return;
    if ((globalThis as { __noGlStateWbuf?: boolean }).__noGlStateWbuf) {
        Logger.log(LogCategory.SYSTEM, "[WBUF] opengl32 state ring DISABLED (__noGlStateWbuf)");
        return;
    }

    const apiRegistry = APIRegistry.getInstance();
    let count = 0;
    for (const [name, argCount] of RING_FUNCTIONS) {
        const impl = exports[name];
        if (typeof impl !== "function") continue;

        // A wrong arity here corrupts both the ring stride and the stub's RET N — a stack
        // skew that surfaces far from this file. Check it against the same descriptor the
        // stub was generated from and keep the OUT trap rather than register a broken one.
        const declared = apiRegistry.getArgCount("opengl32", name);
        if (declared !== undefined && declared !== argCount) {
            Logger.error(LogCategory.SYSTEM,
                `[WBUF] opengl32:${name} arity ${argCount} disagrees with the API descriptor ` +
                `(${declared}) — left on the OUT trap`);
            continue;
        }

        // One array per registration, reused: the drain is the hot path and the
        // export table's display-list wrapper copies what it needs to keep.
        const args: number[] = new Array(argCount).fill(0);
        const handler: WriteBufHandler = (mem8, mem32, dataPtr) => {
            const base = dataPtr >> 2;
            for (let i = 0; i < argCount; i++) args[i] = mem32[base + i] >>> 0;
            // Every entrypoint listed above ignores the X86Context — the drain has no
            // trap frame to hand it, which is exactly why nothing that reads one qualifies.
            impl(null as unknown as X86Context, mem8, args);
        };

        dispatcher.registerWriteBufferFunction("opengl32", name, argCount, handler, true /* stdcall */);
        count++;
    }

    Logger.log(LogCategory.SYSTEM,
        `[WBUF] Registered ${count} opengl32 state/bind/array entrypoints on the Tier-0 ring`);
}
