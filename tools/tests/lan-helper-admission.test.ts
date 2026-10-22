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
    const acknowledgeControl=(request:Buffer)=>{
        const frame=Buffer.alloc(20);frame.writeUInt32LE(21);frame.writeUInt32LE(12,4);
        request.copy(frame,8,8,20);
        (helper as unknown as {accept(frame:Buffer):void}).accept(frame);
    };
    return {helper,frames,callbacks,errors,acknowledge,acknowledgeControl,get killed(){return killed}};
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
        const controls=Math.floor((TCP_WINDOW+8192-TCP_SEGMENT-12)/20);
        for(let index=0;index<controls;index++){
            pipe.helper.setKeepAlive(!!(index&1));
            pipe.acknowledgeControl(pipe.frames.at(-1)!);
        }
        const before=pipe.frames.length;
        expect(pipe.helper.write(new Uint8Array(TCP_SEGMENT*2),error=>{if(error)failures.push((error as Error&{code:number}).code)})).toBe(false);
        await Promise.resolve();
        expect(pipe.frames).toHaveLength(before);expect(failures).toEqual([10055]);expect(pipe.killed).toBe(0);expect(pipe.errors).toEqual([]);
    }finally{pipe.helper.destroy()}
});
test('native controls retain bounded escrow until an acknowledged OS result',()=>{
    const pipe=controlledPipe(true),observed:Array<{option:number;enabled:boolean}>=[];
    pipe.helper.on('option',option=>observed.push(option));
    try{
        for(let index=0;index<64;index++)pipe.helper.setKeepAlive(!!(index&1));
        expect(pipe.frames).toHaveLength(64);expect(pipe.errors).toEqual([]);
        pipe.acknowledgeControl(pipe.frames[0]);
        expect(observed).toEqual([{option:1,enabled:false}]);
        pipe.helper.setNoDelay(true);
        expect(pipe.frames).toHaveLength(65);expect(pipe.errors).toEqual([]);
        pipe.helper.setNoDelay(false);
        expect(pipe.frames).toHaveLength(65);expect(pipe.errors).toEqual([10055]);expect(pipe.killed).toBe(1);
    }finally{pipe.helper.destroy()}
});
test('many small reads return one coalesced receive credit without losing its byte count',async()=>{
    const pipe=controlledPipe(true);
    try{
        const frame=Buffer.alloc(8+4096);frame.writeUInt32LE(11);frame.writeUInt32LE(4096,4);
        (pipe.helper as unknown as {accept(frame:Buffer):void}).accept(frame);
        for(let index=0;index<4096;index++)expect(pipe.helper.read(1)?.length).toBe(1);
        expect(pipe.frames).toHaveLength(0);await Promise.resolve();
        expect(pipe.frames).toHaveLength(1);
        expect([pipe.frames[0].readUInt32LE(),pipe.frames[0].readUInt32LE(8)]).toEqual([4,4096]);
        expect(pipe.errors).toEqual([]);
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
