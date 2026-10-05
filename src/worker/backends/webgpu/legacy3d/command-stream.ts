import {
    Legacy3DCommandType,
    Legacy3DClearCommand,
    Legacy3DDrawCommand,
    LegacyPrimitiveTopology,
} from "./types";

const TOPOLOGY_TO_ID: Record<LegacyPrimitiveTopology, number> = {
    "point-list": 1,
    "line-list": 2,
    "triangle-list": 3,
};

const ID_TO_TOPOLOGY: Record<number, LegacyPrimitiveTopology> = {
    1: "point-list",
    2: "line-list",
    3: "triangle-list",
};

/**
 * Vertices are staged in the EXACT layout the GPU vertex buffer wants —
 * position vec3, uv vec2, oow f32, colour unorm8x4 — so uploading a frame is one
 * writeBuffer over a subarray. Seven parallel `number[]`s repacked through a
 * DataView cost a re-encode of every float on the way to the GPU, and a Glide
 * title pushes thousands of vertices per frame.
 */
export const LEGACY3D_VERTEX_FLOATS = 7;
export const LEGACY3D_VERTEX_BYTES = LEGACY3D_VERTEX_FLOATS * 4;

/** Commands are 18 int lanes each, one command contiguous (type + A..M + clip rect). */
export const LEGACY3D_CMD_STRIDE = 18;
export const CI_TYPE = 0;
export const CI_A = 1;
export const CI_B = 2;
export const CI_C = 3;
export const CI_D = 4;
export const CI_E = 5;
export const CI_F = 6;
export const CI_G = 7;
export const CI_H = 8;
export const CI_I = 9;
export const CI_J = 10;
export const CI_K = 11;
export const CI_L = 12;
export const CI_M = 13;
// grClipWindow, in the same screen space as the vertices.
export const CI_CLIP_X0 = 14;
export const CI_CLIP_Y0 = 15;
export const CI_CLIP_X1 = 16;
export const CI_CLIP_Y1 = 17;

const INITIAL_VERTICES = 4096;
const INITIAL_COMMANDS = 1024;

export class Legacy3DCommandStream {
    /** Interleaved vertex staging; `vertexU32` is the same bytes, for the packed colour. */
    private vertexBuffer = new ArrayBuffer(INITIAL_VERTICES * LEGACY3D_VERTEX_BYTES);
    vertexFloats = new Float32Array(this.vertexBuffer);
    vertexU32 = new Uint32Array(this.vertexBuffer);
    private vertices = 0;

    /** Flat command lanes; read with the CI_* offsets above. */
    commands = new Int32Array(INITIAL_COMMANDS * LEGACY3D_CMD_STRIDE);
    private commandsUsed = 0;

    reset(): void {
        this.vertices = 0;
        this.commandsUsed = 0;
    }

    hasCommands(): boolean {
        return this.commandsUsed > 0;
    }

    get commandCount(): number {
        return this.commandsUsed;
    }

    getVertexCount(): number {
        return this.vertices;
    }

    /** The used vertex bytes, ready for a single queue.writeBuffer. */
    vertexBytesUsed(): number {
        return this.vertices * LEGACY3D_VERTEX_BYTES;
    }

    commandTypeAt(index: number): number {
        return this.commands[index * LEGACY3D_CMD_STRIDE + CI_TYPE]!;
    }

    /** Every command in the frame is a clear (nothing was actually drawn). */
    onlyClears(): boolean {
        for (let i = 0; i < this.commandsUsed; i++) {
            if (this.commandTypeAt(i) !== Legacy3DCommandType.Clear) return false;
        }
        return this.commandsUsed > 0;
    }

    private growVertices(): void {
        const next = new ArrayBuffer(this.vertexBuffer.byteLength * 2);
        new Uint8Array(next).set(new Uint8Array(this.vertexBuffer));
        this.vertexBuffer = next;
        this.vertexFloats = new Float32Array(next);
        this.vertexU32 = new Uint32Array(next);
    }

    private commandSlot(): number {
        if ((this.commandsUsed + 1) * LEGACY3D_CMD_STRIDE > this.commands.length) {
            const next = new Int32Array(this.commands.length * 2);
            next.set(this.commands);
            this.commands = next;
        }
        return this.commandsUsed++ * LEGACY3D_CMD_STRIDE;
    }

    pushVertex(x: number, y: number, z: number, u: number, v: number, q: number, color: number): number {
        if ((this.vertices + 1) * LEGACY3D_VERTEX_FLOATS > this.vertexFloats.length) {
            this.growVertices();
        }
        const idx = this.vertices++;
        const base = idx * LEGACY3D_VERTEX_FLOATS;
        const f = this.vertexFloats;
        f[base] = x;
        f[base + 1] = y;
        f[base + 2] = z;
        f[base + 3] = u;
        f[base + 4] = v;
        f[base + 5] = q;
        this.vertexU32[base + 6] = color >>> 0;
        return idx;
    }

    pushClear(command: Legacy3DClearCommand): void {
        const c = this.commandSlot();
        const a = this.commands;
        a[c + CI_TYPE] = Legacy3DCommandType.Clear;
        a[c + CI_A] = command.color | 0;
        a[c + CI_B] = command.depth | 0;
        a[c + CI_C] = command.clearColor ? 1 : 0;
        a[c + CI_D] = command.clearDepth ? 1 : 0;
    }

    pushDraw(command: Legacy3DDrawCommand): void {
        const flags =
            (command.useTexture ? 1 : 0) |
            (command.blendEnabled ? 1 << 1 : 0) |
            (command.depthTestEnabled ? 1 << 2 : 0) |
            (command.depthWriteEnabled ? 1 << 3 : 0) |
            (command.alphaTestEnabled ? 1 << 4 : 0) |
            (command.clampS ? 1 << 5 : 0) |
            (command.clampT ? 1 << 6 : 0) |
            (command.filterLinear ? 1 << 7 : 0) |
            ((command.depthFunction & 0x7) << 8) |
            (command.colorMaskRgb ? 1 << 11 : 0) |
            (command.colorMaskAlpha ? 1 << 12 : 0) |
            (command.mipMapEnabled ? 1 << 13 : 0);

        const c = this.commandSlot();
        const a = this.commands;
        a[c + CI_TYPE] = Legacy3DCommandType.Draw;
        a[c + CI_A] = command.firstVertex | 0;
        a[c + CI_B] = command.vertexCount | 0;
        a[c + CI_C] = TOPOLOGY_TO_ID[command.topology] ?? TOPOLOGY_TO_ID["triangle-list"];
        a[c + CI_D] = command.textureHandle | 0;
        a[c + CI_E] = flags;
        a[c + CI_F] = command.alphaRef | 0;
        a[c + CI_G] = command.cullMode | 0;
        a[c + CI_H] = command.constantColor | 0;
        a[c + CI_I] = command.colorCombine | 0;
        a[c + CI_J] = command.alphaCombine | 0;
        a[c + CI_K] = command.blend | 0;
        a[c + CI_L] = command.fogColor | 0;
        a[c + CI_M] = ((command.fogMode & 0xffff) | ((command.alphaTestFunc & 0x7) << 16)) | 0;
        a[c + CI_CLIP_X0] = command.clipX0 | 0;
        a[c + CI_CLIP_Y0] = command.clipY0 | 0;
        a[c + CI_CLIP_X1] = command.clipX1 | 0;
        a[c + CI_CLIP_Y1] = command.clipY1 | 0;
    }

    getClearCommand(index: number): Legacy3DClearCommand | null {
        const c = index * LEGACY3D_CMD_STRIDE;
        if (this.commands[c + CI_TYPE] !== Legacy3DCommandType.Clear) {
            return null;
        }
        const a = this.commands;
        return {
            color: a[c + CI_A]! >>> 0,
            depth: a[c + CI_B]! >>> 0,
            clearColor: a[c + CI_C] !== 0,
            clearDepth: a[c + CI_D] !== 0,
        };
    }

    getDrawCommand(index: number): Legacy3DDrawCommand | null {
        const c = index * LEGACY3D_CMD_STRIDE;
        if (this.commands[c + CI_TYPE] !== Legacy3DCommandType.Draw) {
            return null;
        }
        const a = this.commands;
        const flags = a[c + CI_E]! >>> 0;
        const fogPacked = a[c + CI_M]! >>> 0;
        return {
            firstVertex: a[c + CI_A]!,
            vertexCount: a[c + CI_B]!,
            topology: ID_TO_TOPOLOGY[a[c + CI_C]!] ?? "triangle-list",
            textureHandle: a[c + CI_D]!,
            useTexture: (flags & 1) !== 0,
            blendEnabled: (flags & (1 << 1)) !== 0,
            depthTestEnabled: (flags & (1 << 2)) !== 0,
            depthWriteEnabled: (flags & (1 << 3)) !== 0,
            depthFunction: (flags >>> 8) & 0x7,
            alphaTestEnabled: (flags & (1 << 4)) !== 0,
            alphaRef: a[c + CI_F]! >>> 0,
            cullMode: a[c + CI_G]! >>> 0,
            constantColor: a[c + CI_H]! >>> 0,
            clampS: (flags & (1 << 5)) !== 0,
            clampT: (flags & (1 << 6)) !== 0,
            filterLinear: (flags & (1 << 7)) !== 0,
            colorMaskRgb: (flags & (1 << 11)) !== 0,
            colorMaskAlpha: (flags & (1 << 12)) !== 0,
            mipMapEnabled: (flags & (1 << 13)) !== 0,
            colorCombine: a[c + CI_I]! >>> 0,
            alphaCombine: a[c + CI_J]! >>> 0,
            blend: a[c + CI_K]! >>> 0,
            fogColor: a[c + CI_L]! >>> 0,
            fogMode: fogPacked & 0xffff,
            alphaTestFunc: (fogPacked >>> 16) & 0x7,
            clipX0: a[c + CI_CLIP_X0]!,
            clipY0: a[c + CI_CLIP_Y0]!,
            clipX1: a[c + CI_CLIP_X1]!,
            clipY1: a[c + CI_CLIP_Y1]!,
        };
    }

    /** Screen/uv/colour of one staged vertex — diagnostics (frame capture) only. */
    readVertex(index: number, out: { x: number; y: number; z: number; u: number; v: number; q: number; color: number }): void {
        const base = index * LEGACY3D_VERTEX_FLOATS;
        const f = this.vertexFloats;
        out.x = f[base]!;
        out.y = f[base + 1]!;
        out.z = f[base + 2]!;
        out.u = f[base + 3]!;
        out.v = f[base + 4]!;
        out.q = f[base + 5]!;
        out.color = this.vertexU32[base + 6]! >>> 0;
    }
}
