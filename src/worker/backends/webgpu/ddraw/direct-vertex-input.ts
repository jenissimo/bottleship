import type { DeclStreamCopy } from "../d3d8/decl-to-ffp";
import { newVertexReuseStats } from "./retained-geometry";
import {
    D3DFVF_DIFFUSE, D3DFVF_NORMAL, D3DFVF_POSITION_MASK, D3DFVF_SPECULAR, D3DFVF_XYZ,
} from "../../../modules/ddraw/constants";

export const ffpDirectVertexStats = { draws: 0, streamBytes: 0, stagedBytes: 0, ...newVertexReuseStats() };

interface Attribute {
    location: number;
    name: string;
    format: GPUVertexFormat;
    type: string;
    size: number;
}

const position: Attribute = { location: 0, name: "pos", format: "float32x3", type: "vec3f", size: 12 };
const normal: Attribute = { location: 1, name: "normal", format: "float32x3", type: "vec3f", size: 12 };
const color: Attribute = { location: 2, name: "color", format: "unorm8x4", type: "vec4f", size: 4 };
const specular: Attribute = { location: 3, name: "specular", format: "unorm8x4", type: "vec4f", size: 4 };
const texCoords: Attribute[] = ["uv", "uv1", "uv2"].map((name, index) =>
    ({ location: 4 + index, name, format: "float32x2", type: "vec2f", size: 8 }));

export interface DirectVertexLayout {
    readonly key: string;
    readonly shaderParameters: string;
    readonly shaderPrologue: string;
    readonly streamNumbers: readonly number[];
    readonly layouts: GPUVertexBufferLayout[];
}

export interface DirectVertexStreams {
    readonly layout: DirectVertexLayout;
    /** Guest addresses of the streams' first vertex, in pipeline slot order. */
    readonly addresses: readonly number[];
    /** Unique contents versions of the bound VB objects, in pipeline slot order. */
    readonly versions?: readonly (number | undefined)[];
}

export function makeDirectVertexLayout(
    fvf: number, strides: readonly number[], copies?: readonly DeclStreamCopy[],
): DirectVertexLayout | null {
    const uvCount = (fvf >>> 8) & 15;
    const supported = D3DFVF_POSITION_MASK | D3DFVF_NORMAL | D3DFVF_DIFFUSE | D3DFVF_SPECULAR | 0xf00;
    if ((fvf & D3DFVF_POSITION_MASK) !== D3DFVF_XYZ || (fvf & ~supported) !== 0 || uvCount > 3) return null;
    const attributes = [position];
    if (fvf & D3DFVF_NORMAL) attributes.push(normal);
    if (fvf & D3DFVF_DIFFUSE) attributes.push(color);
    if (fvf & D3DFVF_SPECULAR) attributes.push(specular);
    attributes.push(...texCoords.slice(0, uvCount));
    if (copies && copies.length !== attributes.length) return null;

    const byStream = new Map<number, GPUVertexAttribute[]>();
    const shaderParameters: string[] = [];
    const shaderPrologue: string[] = [];
    const attributeKey: string[] = [];
    let cursor = 0;
    for (const attribute of attributes) {
        const copy = copies?.find(part => part.dstOffset === cursor);
        const stream = copy?.stream ?? 0;
        const sourceOffset = copy?.srcOffset ?? cursor;
        const stride = strides[stream] ?? 0;
        if ((copies && (!copy || copy.size !== attribute.size || copy.slotSize !== attribute.size)) ||
            stride <= 0 || stride > 2048 || (stride & 3) !== 0 ||
            sourceOffset < 0 || (sourceOffset & 3) !== 0 || sourceOffset + attribute.size > stride) return null;
        const field = `raw_${attribute.name}`;
        shaderParameters.push(`@location(${attribute.location}) ${field}: ${attribute.type}`);
        const value = attribute === position ? `vec4f(${field}, 1.0)` : copy?.swizzleColorBytes ? `${field}.bgra` : field;
        shaderPrologue.push(`let ${attribute.name} = ${value};`);
        attributeKey.push(`${attribute.location}:${stream}:${sourceOffset}:${stride}:${Number(!!copy?.swizzleColorBytes)}`);
        let layout = byStream.get(stream);
        if (!layout) byStream.set(stream, layout = []);
        layout.push({ shaderLocation: attribute.location, format: attribute.format, offset: sourceOffset });
        cursor += attribute.size;
    }
    if (!(fvf & D3DFVF_NORMAL)) shaderPrologue.push("let normal = vec3f(0.0, 0.0, 1.0);");
    if (!(fvf & D3DFVF_DIFFUSE)) shaderPrologue.push("let color = vec4f(1.0);");
    if (!(fvf & D3DFVF_SPECULAR)) shaderPrologue.push("let specular = vec4f(0.0, 0.0, 0.0, 1.0);");
    if (uvCount === 0) shaderPrologue.push("let uv = vec2f(0.0);");
    if (uvCount < 2) shaderPrologue.push("let uv1 = uv;");
    if (uvCount < 3) shaderPrologue.push("let uv2 = uv1;");
    const streamNumbers = [...byStream.keys()];
    return {
        key: attributeKey.join("|"),
        shaderParameters: shaderParameters.join(", "),
        shaderPrologue: shaderPrologue.join("\n"),
        streamNumbers,
        layouts: streamNumbers.map(stream => ({ arrayStride: strides[stream], attributes: byStream.get(stream)! })),
    };
}

export function directVertexBytes(layout: DirectVertexLayout, vertexCount: number): number {
    return layout.layouts.reduce((bytes, stream) => bytes + stream.arrayStride * vertexCount, 0);
}
