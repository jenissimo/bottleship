import {afterEach,expect,test} from 'bun:test';
import {DepthColorPadding} from '../../src/worker/backends/webgpu/d3d9/depth-color-padding';
const originalUsage=globalThis.GPUTextureUsage;
afterEach(()=>{Object.assign(globalThis,{GPUTextureUsage:originalUsage});});

test('oversized depth preserves logical color contents, including a cube face, without touching other pixels',()=>{
    Object.assign(globalThis,{GPUTextureUsage:{COPY_SRC:1,COPY_DST:2,RENDER_ATTACHMENT:16}});
    const created:any[]=[];
    const make=(width:number,height:number,layers=1)=>({width,height,sampleCount:1,format:'rgba8unorm',
        pixels:new Uint32Array(width*height*layers),createView:()=>({}),destroy(){this.dead=true;},dead:false});
    const device={createTexture(d:any){const t=make(d.size.width,d.size.height);created.push(t);return t;}} as any;
    let copies=0;
    const encoder={copyTextureToTexture(src:any,dst:any,size:any){
        copies++;
        for(let y=0;y<size.height;y++)for(let x=0;x<size.width;x++) {
            const index=(t:any,o:any)=>((o?.z??0)*t.height+y)*t.width+x;
            dst.texture.pixels[index(dst.texture,dst.origin)]=src.texture.pixels[index(src.texture,src.origin)];
        }
    }} as any;
    const target=make(3,2,6);
    target.pixels.fill(17);
    target.pixels.set([1,2,3,4,5,6],12);
    const source={texture:target as any,format:'rgba8unorm' as GPUTextureFormat,layer:2};
    const padding=new DepthColorPadding();
    const views=padding.prepare(device,encoder,[source,null],5,4);
    expect(views[0]).not.toBeNull();expect(views[1]).toBeNull();
    expect([...created[0].pixels.slice(0,10)]).toEqual([1,2,3,0,0,4,5,6,0,0]);
    // The canonical render writes a selected pixel and an out-of-target pixel.
    created[0].pixels[6]=99;created[0].pixels[19]=101;
    padding.restore(encoder,[source,null],5,4);
    expect([...target.pixels.slice(12,18)]).toEqual([1,2,3,4,99,6]);
    expect([...target.pixels.slice(0,12)]).toEqual(Array(12).fill(17));
    expect([...target.pixels.slice(18)]).toEqual(Array(18).fill(17));
    expect(copies).toBe(2);
    padding.prepare(device,encoder,[source],5,4);
    expect(created.length).toBe(1);
    padding.destroy();expect(created[0].dead).toBe(true);
});

test('padding rejects a smaller attachment and multisampled copies',()=>{
    const padding=new DepthColorPadding();
    const source={texture:{width:6,height:4,sampleCount:1} as any,format:'rgba8unorm' as GPUTextureFormat,layer:0};
    expect(()=>padding.prepare({} as any,{} as any,[source],5,4)).toThrow('contained');
    source.texture.width=3;source.texture.sampleCount=4;
    expect(()=>padding.prepare({} as any,{} as any,[source],5,4)).toThrow('single-sample');
});
