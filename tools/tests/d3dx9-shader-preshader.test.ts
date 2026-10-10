import {expect,test} from 'bun:test';
import {applyPassStates} from '../../src/worker/modules/d3dx9/effect-apply';
import {ShaderPreshader} from '../../src/worker/modules/d3dx9/effect-shader-preshader';
import {parsePreshader} from '../../src/worker/modules/d3dx9/effect-preshader';
import {EffectAssignmentKind,EffectParamClass,EffectParamType,type EffectInstance,type EffectParameter,type EffectPass} from '../../src/worker/modules/d3dx9/effect-state';

const comment=(fourcc:number,payload:number[])=>[((payload.length+1)<<16)|0xfffe,fourcc,...payload];
const operand=(table:number,offset:number)=>[0,table,offset];
const ins=(op:number,inputs:number[][],table:number,offset:number)=>[op,inputs.length,...inputs.flat(),...operand(table,offset)];
const literals=(values:number[])=>{
    const padded=new Float64Array(Math.ceil(values.length/4)*4);padded.set(values);
    return [padded.length,...new Uint32Array(padded.buffer)];
};
const bytes=(words:number[])=>new Uint8Array(new Uint32Array(words).buffer);

function sizeCtab():number[] {
    const raw=new Uint8Array(76),v=new DataView(raw.buffer);
    v.setUint32(0,28,true);v.setUint32(12,1,true);v.setUint32(16,28,true);
    v.setUint32(28,64,true);v.setUint16(32,2,true);v.setUint16(36,1,true);v.setUint32(40,48,true);
    v.setUint16(48,1,true);v.setUint16(50,3,true);v.setUint16(52,1,true);v.setUint16(54,2,true);
    raw.set(new TextEncoder().encode('TargetSize\0'),64);
    return [...new Uint32Array(raw.buffer)];
}

function shader():Uint8Array {
    const ops=[
        ins(0x10300001,[operand(2,0)],7,0),
        ins(0x20500001,[operand(1,0),operand(7,0)],4,48),
        ins(0x20500001,[operand(1,1),operand(7,0)],4,49),
        ins(0x10300001,[operand(2,1)],7,0),
        ins(0x20500001,[operand(1,0),operand(7,0)],4,50),
        ins(0x20500001,[operand(1,1),operand(7,0)],4,51),
    ];
    const pres=[0x46580200,...comment(0x42415443,sizeCtab()),
        ...comment(0x54494c43,literals([-.5,.5])),...comment(0x434c5846,[ops.length,...ops.flat()])];
    return bytes([0xfffe0200,...comment(0x53455250,pres),0xffff]);
}

function scene() {
    const data=shader();
    const value=new Float32Array([800,600]);
    const parameter:EffectParameter={name:'TargetSize',semantic:'',type:EffectParamType.Float,
        paramClass:EffectParamClass.Vector,rows:1,columns:2,elements:0,annotations:[],members:[],
        value:new Uint8Array(value.buffer),objectPtr:0,objectIndex:-1};
    const pass:EffectPass={name:'resample',annotations:[],assignments:[{
        state:146,index:0,kind:EffectAssignmentKind.Shader,objectIndex:0}]};
    const instance:EffectInstance={model:{creator:'test',parameters:[parameter],techniques:[],objects:[{data,text:''}]},
        annotations:[],devicePtr:1,currentTechnique:0,activePass:0};
    const bank=new Float32Array(256*4).fill(57),uploads:number[]=[];
    let publishes=0;
    const deps={device:{createVertexShader:()=>({hr:0,handle:1,bytecode:new Uint32Array(data.buffer)}),
        setVertexShader(){},setVertexShaderConstantFFromArray(start:number,data:Float32Array){
            uploads.push(start);bank.set(data,start*4);}},mem:new Uint8Array(0),publishObject:()=>++publishes} as any;
    return {value,pass,instance,bank,uploads,deps,publishes:()=>publishes};
}

test('an applied shader computes texel offsets from parameters on every pass and preserves unrelated registers',()=>{
    const s=scene();
    expect(applyPassStates(s.deps,s.instance,s.pass)).toBe(0);
    expect([...s.bank.slice(48,52)]).toEqual([...new Float32Array([-.5/800,.5/800,-.5/600,.5/600])]);
    expect([...s.bank.slice(0,48)]).toEqual(Array(48).fill(57));
    expect([...s.bank.slice(52)]).toEqual(Array(972).fill(57));
    s.value.set([640,480]);
    expect(applyPassStates(s.deps,s.instance,s.pass)).toBe(0);
    expect([...s.bank.slice(48,52)]).toEqual([...new Float32Array([-.5/640,.5/640,-.5/480,.5/480])]);
    expect(s.uploads).toEqual([12,12]);expect(s.publishes()).toBe(1);
});

test('missing preshader input fails the pass without uploading stale results',()=>{
    const s=scene();s.instance.model.parameters=[];
    expect(applyPassStates(s.deps,s.instance,s.pass)).toBe(0x8876086c);
    expect(s.uploads).toEqual([]);expect([...s.bank]).toEqual(Array(1024).fill(57));
});

test('preshader integer and Boolean outputs reach the pixel shader banks with sparse register ranges',()=>{
    const ops=[ins(0x10000001,[operand(1,0)],6,24),ins(0x10000001,[operand(1,1)],5,20)];
    const pres=parsePreshader(bytes([0x46580200,...comment(0x54494c43,literals([12.5,-2])),
        ...comment(0x434c5846,[ops.length,...ops.flat()])]));
    expect(pres).not.toBeNull();
    const writes:any[]=[];
    const device={setPixelShaderConstantIFromArray:(s:number,d:Int32Array)=>writes.push(['i',s,[...d]]),
        setPixelShaderConstantBFromArray:(s:number,d:Int32Array)=>writes.push(['b',s,[...d]])} as any;
    expect(new ShaderPreshader(pres!).apply(device,[],false)).toBe(true);
    expect(writes).toEqual([['i',6,[12,0,0,0]],['b',5,[1]]]);
});
