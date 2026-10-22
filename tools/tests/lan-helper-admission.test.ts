import {expect,test} from 'bun:test';
import {NativeHelperSocket} from '../../packages/lan/src/native-helper';
import {TCP_SEGMENT,TCP_WINDOW} from '../../packages/lan/src/tcp-protocol';

function controlledPipe(completeWrites:boolean){
    const helper=new NativeHelperSocket('unused'),frames:Buffer[]=[],callbacks:Array<()=>void>=[],errors:number[]=[];
    let killed=0;
    const input={writable:true,write(bytes:Buffer,complete:()=>void){
        frames.push(Buffer.from(bytes));if(completeWrites)complete();else callbacks.push(complete);return false;
    },destroy(){}};
    helper.on('error',error=>errors.push(error.code));
    Object.assign(helper,{connected:true,child:{stdin:input,stdout:{destroy(){}},stderr:{destroy(){}},kill(){killed++}}});
    const acknowledge=(id:number)=>{
        const frame=Buffer.alloc(12);frame.writeUInt32LE(15);frame.writeUInt32LE(4,4);frame.writeUInt32LE(id,8);
        (helper as unknown as {accept(frame:Buffer):void}).accept(frame);
    };
    return {helper,frames,callbacks,errors,acknowledge,get killed(){return killed}};
}
test('segmented native writes reserve every record before accepting any payload',async()=>{
    const pipe=controlledPipe(true);let completed=0;const rejected:number[]=[];
    try{
        for(let index=0;index<250;index++)expect(pipe.helper.write(Uint8Array.of(index),error=>{if(!error)completed++})).toBe(true);
        const before=pipe.frames.length;
        expect(pipe.helper.write(new Uint8Array(TCP_SEGMENT*7),error=>{if(error)rejected.push((error as Error&{code:number}).code)})).toBe(false);
        await Promise.resolve();
        expect(pipe.frames).toHaveLength(before);expect(rejected).toEqual([10055]);expect(pipe.errors).toEqual([]);
        for(const frame of pipe.frames.slice())pipe.acknowledge(frame.readUInt32LE(8));
        expect(completed).toBe(250);
        expect(pipe.helper.write(new Uint8Array(TCP_SEGMENT*7))).toBe(true);
    }finally{pipe.helper.destroy()}
});
test('pipe backpressure rejects a whole segmented write before its first record',async()=>{
    const pipe=controlledPipe(false),failures:number[]=[];
    try{
        const controls=Math.floor((TCP_WINDOW+4096-TCP_SEGMENT-12)/16);
        for(let index=0;index<controls;index++)pipe.helper.setKeepAlive(!!(index&1));
        const before=pipe.frames.length;
        expect(pipe.helper.write(new Uint8Array(TCP_SEGMENT*2),error=>{if(error)failures.push((error as Error&{code:number}).code)})).toBe(false);
        await Promise.resolve();
        expect(pipe.frames).toHaveLength(before);expect(failures).toEqual([10055]);expect(pipe.killed).toBe(0);expect(pipe.errors).toEqual([]);
    }finally{pipe.helper.destroy()}
});
test('native DATA and urgent writes after FIN fail without sending another record',async()=>{
    const pipe=controlledPipe(true),failures:number[]=[];
    try{
        pipe.helper.end();const before=pipe.frames.length;
        expect(pipe.helper.write(Uint8Array.of(1),error=>{if(error)failures.push((error as Error&{code:number}).code)})).toBe(false);
        pipe.helper.sendUrgent(2,error=>{if(error)failures.push((error as Error&{code:number}).code)});
        await Promise.resolve();
        expect(pipe.frames).toHaveLength(before);expect(failures).toEqual([10058,10058]);expect(pipe.killed).toBe(0);
    }finally{pipe.helper.destroy()}
});
