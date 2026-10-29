import {expect,test} from "bun:test";
import {probeOfflineWgslValidator,validateWgslOffline} from "../d3d9-parity/wgsl-validator";
const validator = probeOfflineWgslValidator();
test.skipIf(!validator.available)("counting MRT/depth shader validates as WGSL",()=>{
    const source = "struct PsInput { @builtin(position) position:vec4<f32>, } struct PsOutput { @location(0) color:vec4<f32>, @builtin(frag_depth) depth:f32, } @fragment fn fs_main(in:PsInput) -> PsOutput { var out:PsOutput; out.color=vec4<f32>(1.0); out.depth=in.position.z; return out; }";
    const result=validateWgslOffline(countingFragment(source,1),validator);
    expect(result.status,JSON.stringify(result)).toBe("passed");
});
import {countingFragment} from "../../src/worker/backends/webgpu/d3d9/precise-occlusion";
test("counting fragment preserves discard and the original color result",()=>{
    const source = "@fragment fn fs_main(in: PsInput) -> @location(0) vec4<f32> { if(in.color.a<0.5){discard;} return in.color; }";
    const result=countingFragment(source,1);
    expect(result).toContain("if(in.color.a<0.5){discard;}");
    expect(result).toContain("out.color = value;");
    expect(result).toContain("@location(1) querySamples: f32");
    expect(result).toContain("let value = d3d9_query_fragment(in);");
    expect(result.match(/@fragment/g)).toHaveLength(1);
});
test("counting fragment preserves MRT outputs and explicit fragment depth",()=>{
    const source = "struct PsOutput { @location(0) color0: vec4<f32>, @location(2) color2: vec4<f32>, @builtin(frag_depth) depth: f32, } @fragment fn fs_main(in: PsInput) -> PsOutput { var out: PsOutput; return out; }";
    const result=countingFragment(source,3);
    expect(result).toContain("out.color0 = value.color0;");
    expect(result).toContain("out.color2 = value.color2;");
    expect(result).toContain("out.depth = value.depth;");
    expect(result).toContain("@builtin(frag_depth) depth: f32");
});
