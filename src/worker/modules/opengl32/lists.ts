import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { OpenGLContext, GLDisplayList, GLPrebakedItem, VERT_FLOATS } from "./context";
import { GL_COMPILE, GL_COMPILE_AND_EXECUTE, GL_INVALID_VALUE, GL_INVALID_OPERATION,
         GL_2_BYTES, GL_3_BYTES, GL_4_BYTES, GL_UNSIGNED_BYTE, GL_SHORT, GL_UNSIGNED_SHORT,
         GL_INT, GL_UNSIGNED_INT, GL_BYTE, GL_FLOAT } from "./constants";
import { bitsToF32, assembleFlatVerts, emitDrawCommandFromPrebaked } from "./immediate";

function prebakeDisplayList(
    ctx: OpenGLContext,
    commands: Array<{ fn: string; args: number[] }>,
): GLPrebakedItem[] | null {
    // A nested list or an in-list enable may turn lighting on after replay starts.
    // Preserve vertex-time inherited attributes/materials through ordinary replay.
    if (commands.some(cmd => cmd.fn === 'glCallList' || cmd.fn === 'glCallLists' ||
        (cmd.fn === 'glEnable' && cmd.args[0] === 0x0b50))) return null;
    const seq: GLPrebakedItem[] = [];

    // Vertex attribute simulation state for baking
    const bakeColor = new Float32Array([1, 1, 1, 1]);
    const bakeNormal = new Float32Array([0, 0, 1]);
    const bakeTexCoord0 = new Float32Array(2);
    const bakeTexCoord1 = new Float32Array(2);

    let inPrim = false;
    let primMode = 0;
    let finalColorCommand: { fn: string; args: number[] } | null = null;
    const primBuf: number[] = [];

    const mem = ctx.process.getCurrentMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset);

    function pushVert(x: number, y: number, z: number, w: number): void {
        primBuf.push(
            x, y, z, w,
            bakeColor[0], bakeColor[1], bakeColor[2], bakeColor[3],
            bakeNormal[0], bakeNormal[1], bakeNormal[2],
            bakeTexCoord0[0], bakeTexCoord0[1], bakeTexCoord1[0], bakeTexCoord1[1],
            0, 0, 0, // secondary RGB, computed at replay
        );
    }

    const _asmLocal = new Float32Array(65536 * VERT_FLOATS);

    for (const cmd of commands) {
        const fn = cmd.fn;
        const args = cmd.args;
        switch (fn) {
            // --- Primitive assembly ---
            case 'glBegin':
                inPrim = true; primMode = args[0] >>> 0; primBuf.length = 0; break;
            case 'glEnd': {
                inPrim = false;
                const srcCount = primBuf.length / VERT_FLOATS;
                if (srcCount > 0) {
                    const src = new Float32Array(primBuf);
                    const asmCount = assembleFlatVerts(src, srcCount, primMode, _asmLocal);
                    if (asmCount > 0) {
                        const flatVerts = new Float32Array(asmCount * VERT_FLOATS);
                        flatVerts.set(_asmLocal.subarray(0, asmCount * VERT_FLOATS));
                        seq.push({ kind: 'verts', mode: primMode, flatVerts, count: asmCount });
                    }
                }
                primBuf.length = 0;
                if (finalColorCommand) {
                    seq.push({ kind: 'cmd', fn: finalColorCommand.fn, args: finalColorCommand.args });
                    finalColorCommand = null;
                }
                break;
            }
            // --- Vertex ---
            case 'glVertex3f': pushVert(bitsToF32(args[0]), bitsToF32(args[1]), bitsToF32(args[2]), 1); break;
            case 'glVertex2f': pushVert(bitsToF32(args[0]), bitsToF32(args[1]), 0, 1); break;
            case 'glVertex4f': pushVert(bitsToF32(args[0]), bitsToF32(args[1]), bitsToF32(args[2]), bitsToF32(args[3])); break;
            case 'glVertex3fv': { const p = args[0]>>>0; pushVert(dv.getFloat32(p,true), dv.getFloat32(p+4,true), dv.getFloat32(p+8,true), 1); break; }
            case 'glVertex2fv': { const p = args[0]>>>0; pushVert(dv.getFloat32(p,true), dv.getFloat32(p+4,true), 0, 1); break; }
            case 'glVertex4fv': { const p = args[0]>>>0; pushVert(dv.getFloat32(p,true), dv.getFloat32(p+4,true), dv.getFloat32(p+8,true), dv.getFloat32(p+12,true)); break; }
            case 'glVertex3i': pushVert(args[0]|0, args[1]|0, args[2]|0, 1); break;
            case 'glVertex2i': pushVert(args[0]|0, args[1]|0, 0, 1); break;
            case 'glVertex4i': pushVert(args[0]|0, args[1]|0, args[2]|0, args[3]|0); break;
            case 'glVertex3d': pushVert(args[0] as number, args[1] as number, args[2] as number, 1); break;
            case 'glVertex2d': pushVert(args[0] as number, args[1] as number, 0, 1); break;
            // --- Normal ---
            case 'glNormal3f': bakeNormal[0]=bitsToF32(args[0]); bakeNormal[1]=bitsToF32(args[1]); bakeNormal[2]=bitsToF32(args[2]); break;
            case 'glNormal3fv': { const p = args[0]>>>0; bakeNormal[0]=dv.getFloat32(p,true); bakeNormal[1]=dv.getFloat32(p+4,true); bakeNormal[2]=dv.getFloat32(p+8,true); break; }
            case 'glNormal3i': bakeNormal[0]=(args[0]|0)/2147483647; bakeNormal[1]=(args[1]|0)/2147483647; bakeNormal[2]=(args[2]|0)/2147483647; break;
            // --- Color ---
            case 'glColor3f': bakeColor[0]=bitsToF32(args[0]); bakeColor[1]=bitsToF32(args[1]); bakeColor[2]=bitsToF32(args[2]); bakeColor[3]=1; break;
            case 'glColor4f': bakeColor[0]=bitsToF32(args[0]); bakeColor[1]=bitsToF32(args[1]); bakeColor[2]=bitsToF32(args[2]); bakeColor[3]=bitsToF32(args[3]); break;
            case 'glColor3ub': bakeColor[0]=(args[0]&0xFF)/255; bakeColor[1]=(args[1]&0xFF)/255; bakeColor[2]=(args[2]&0xFF)/255; bakeColor[3]=1; break;
            case 'glColor4ub': bakeColor[0]=(args[0]&0xFF)/255; bakeColor[1]=(args[1]&0xFF)/255; bakeColor[2]=(args[2]&0xFF)/255; bakeColor[3]=(args[3]&0xFF)/255; break;
            case 'glColor4fv': { const p=args[0]>>>0; bakeColor[0]=dv.getFloat32(p,true); bakeColor[1]=dv.getFloat32(p+4,true); bakeColor[2]=dv.getFloat32(p+8,true); bakeColor[3]=dv.getFloat32(p+12,true); break; }
            case 'glColor3fv': { const p=args[0]>>>0; bakeColor[0]=dv.getFloat32(p,true); bakeColor[1]=dv.getFloat32(p+4,true); bakeColor[2]=dv.getFloat32(p+8,true); bakeColor[3]=1; break; }
            case 'glColor4ubv': { const p=args[0]>>>0; const m2=ctx.process.getCurrentMemory(); bakeColor[0]=m2[p]/255; bakeColor[1]=m2[p+1]/255; bakeColor[2]=m2[p+2]/255; bakeColor[3]=m2[p+3]/255; break; }
            case 'glColor3ubv': { const p=args[0]>>>0; const m2=ctx.process.getCurrentMemory(); bakeColor[0]=m2[p]/255; bakeColor[1]=m2[p+1]/255; bakeColor[2]=m2[p+2]/255; bakeColor[3]=1; break; }
            // --- TexCoord ---
            case 'glTexCoord1f': bakeTexCoord0[0]=bitsToF32(args[0]); bakeTexCoord0[1]=0; break;
            case 'glTexCoord2f': bakeTexCoord0[0]=bitsToF32(args[0]); bakeTexCoord0[1]=bitsToF32(args[1]); break;
            case 'glTexCoord3f': bakeTexCoord0[0]=bitsToF32(args[0]); bakeTexCoord0[1]=bitsToF32(args[1]); break;
            case 'glTexCoord4f': bakeTexCoord0[0]=bitsToF32(args[0]); bakeTexCoord0[1]=bitsToF32(args[1]); break;
            case 'glTexCoord2fv': { const p=args[0]>>>0; bakeTexCoord0[0]=dv.getFloat32(p,true); bakeTexCoord0[1]=dv.getFloat32(p+4,true); break; }
            case 'glTexCoord2d': bakeTexCoord0[0]=args[0] as number; bakeTexCoord0[1]=args[1] as number; break;
            // --- Non-vertex commands: emit as 'cmd' for normal replay ---
            default:
                if (inPrim) {
                    // Unknown command inside primitive — can't safely bake
                    return null;
                }
                seq.push({ kind: 'cmd', fn, args });
                break;
        }
        // Preserve post-list current color/CM state without replaying every baked
        // vertex. Canonical scalar bits also freeze vector arguments at compile time.
        if (/^glColor[34](f|ub|fv|ubv)$/.test(fn)) {
            const colorCommand = { fn: 'glColor4f', args: Array.from(new Uint32Array(bakeColor.buffer)) };
            if (inPrim) finalColorCommand = colorCommand;
            else seq.push({ kind: 'cmd', ...colorCommand });
        }
    }

    return seq;
}

export function createListExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const replayList = (sysCtx: any, memArg: Uint8Array, list: number): void => {
        const dl = ctx.displayLists.get(list >>> 0);
        if (!dl) return;

        // Lighting needs vertex-time materials and inherited current color. Raw replay
        // preserves those semantics; baked object geometry remains the unlit fast path.
        if (dl.prebaked && ctx.renderMode !== 0x1c02 /* GL_SELECT: retain original polygons */ && !ctx.enableFlags.has(0x0b50 /* GL_LIGHTING */) &&
            !dl.commands.some(cmd => cmd.fn === 'glCallList' || cmd.fn === 'glCallLists' ||
                (cmd.fn === 'glEnable' && cmd.args[0] === 0x0b50))) {
            // Fast path: use pre-baked vertex data
            const glModule = ctx.process.getModule("opengl32") as any;
            const table = glModule?.exports as Record<string, ThunkImplementation> | undefined;
            const prevReplay = ctx.replayingList;
            ctx.replayingList = true;
            try {
                for (const item of dl.prebaked) {
                    if (item.kind === 'cmd') {
                        const fn = table?.[item.fn];
                        if (typeof fn === 'function') fn(sysCtx, memArg, item.args);
                    } else {
                        // Pre-baked flat vertex data; apply current transform + texgen at replay time
                        emitDrawCommandFromPrebaked(ctx, item.mode, item.flatVerts, item.count);
                    }
                }
            } finally {
                ctx.replayingList = prevReplay;
            }
            return;
        }

        // Slow path: raw command replay (fallback for lists that couldn't be baked)
        if (dl.commands.length === 0) return;

        const glModule = ctx.process.getModule("opengl32") as any;
        const table = glModule?.exports as Record<string, ThunkImplementation> | undefined;
        if (!table) return;

        const prevReplay = ctx.replayingList;
        ctx.replayingList = true;
        try {
            for (const cmd of dl.commands) {
                const fn = table[cmd.fn];
                if (typeof fn === "function") {
                    fn(sysCtx, memArg, cmd.args);
                }
            }
        } finally {
            ctx.replayingList = prevReplay;
        }
    };

    exports['glGenLists'] = (_c, _m, args): number => {
        const range = args[0] | 0;
        if (range <= 0) return 0;
        const base = ctx.nextListId;
        ctx.nextListId += range;
        return base;
    };

    exports['glDeleteLists'] = (_c, _m, args): number => {
        const list = args[0] >>> 0;
        const range = args[1] | 0;
        for (let i = 0; i < range; i++) {
            ctx.displayLists.delete(list + i);
        }
        return 0;
    };

    exports['glNewList'] = (_c, _m, args): number => {
        const list = args[0] >>> 0;
        const mode = args[1] >>> 0;
        if (list === 0) { ctx.error = GL_INVALID_VALUE; return 0; }
        if (mode !== GL_COMPILE && mode !== GL_COMPILE_AND_EXECUTE) { ctx.error = GL_INVALID_VALUE; return 0; }
        if (ctx.compilingList !== null) { ctx.error = GL_INVALID_OPERATION; return 0; }
        ctx.compilingList = list;
        ctx.compilingListMode = mode;
        ctx.compilingCommands = [];
        return 0;
    };

    exports['glEndList'] = (): number => {
        if (ctx.compilingList === null) { ctx.error = GL_INVALID_OPERATION; return 0; }
        const prebaked = prebakeDisplayList(ctx, ctx.compilingCommands);
        const dl: GLDisplayList = { commands: ctx.compilingCommands, prebaked };
        ctx.displayLists.set(ctx.compilingList, dl);
        ctx.compilingList = null;
        ctx.compilingCommands = [];
        return 0;
    };

    exports['glCallList'] = (_c, _m, args): number => {
        const list = args[0] >>> 0;
        replayList(_c, _m, list);
        return 0;
    };

    exports['glCallLists'] = (_c, _m, args): number => {
        const n = args[0] | 0;
        const type = args[1] >>> 0;
        const listsPtr = args[2] >>> 0;
        if (n <= 0 || listsPtr === 0) return 0;

        const mem = ctx.process.getCurrentMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let ptr = listsPtr;

        for (let i = 0; i < n; i++) {
            let name = 0;
            switch (type) {
                case GL_BYTE:
                    name = view.getInt8(ptr);
                    ptr += 1;
                    break;
                case GL_UNSIGNED_BYTE:
                    name = view.getUint8(ptr);
                    ptr += 1;
                    break;
                case GL_SHORT:
                    name = view.getInt16(ptr, true);
                    ptr += 2;
                    break;
                case GL_UNSIGNED_SHORT:
                    name = view.getUint16(ptr, true);
                    ptr += 2;
                    break;
                case GL_INT:
                    name = view.getInt32(ptr, true);
                    ptr += 4;
                    break;
                case GL_UNSIGNED_INT:
                    name = view.getUint32(ptr, true) | 0;
                    ptr += 4;
                    break;
                case GL_FLOAT:
                    name = view.getFloat32(ptr, true) | 0;
                    ptr += 4;
                    break;
                case GL_2_BYTES:
                    name = ((view.getUint8(ptr) << 8) | view.getUint8(ptr + 1)) >>> 0;
                    ptr += 2;
                    break;
                case GL_3_BYTES:
                    name = ((view.getUint8(ptr) << 16) | (view.getUint8(ptr + 1) << 8) | view.getUint8(ptr + 2)) >>> 0;
                    ptr += 3;
                    break;
                case GL_4_BYTES:
                    name =
                        ((view.getUint8(ptr) << 24) | (view.getUint8(ptr + 1) << 16) | (view.getUint8(ptr + 2) << 8) | view.getUint8(ptr + 3)) >>> 0;
                    ptr += 4;
                    break;
                default:
                    return 0;
            }

            const listName = (ctx.listBase + name) >>> 0;
            replayList(_c, _m, listName);
        }

        return 0;
    };

    exports['glListBase'] = (_c, _m, args): number => {
        ctx.listBase = args[0] >>> 0;
        return 0;
    };

    exports['glIsList'] = (_c, _m, args): number => {
        return ctx.displayLists.has(args[0] >>> 0) ? 1 : 0;
    };

    return exports;
}
