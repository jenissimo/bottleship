import {expect,test} from 'bun:test';
import {Process} from '../../src/worker/core/process';

test('a retired device lifetime cannot publish queued writes before the process resets',async()=>{
    const owner=Object.create(Process.prototype) as Process;
    const ram=new Uint8Array(32);let active=true,published=0,validated=0,written=0;
    Object.assign(owner,{resetGeneration:7,addressSpace:{
        validateRange(){validated++;return true;},
        write(address:number,bytes:Uint8Array){written++;ram.set(bytes,address);return bytes.length;},
    }});
    owner.enqueueCompletion([{address:8,value:0x12345678,size:4}],()=>{published++;},()=>active);
    active=false;await Promise.resolve();
    expect(owner.resetGeneration).toBe(7);
    expect([validated,written,published]).toEqual([0,0,0]);
    expect([...ram]).toEqual(Array(32).fill(0));
});
test('a current device completion publishes copied values into fresh owner memory',async()=>{
    const owner=Object.create(Process.prototype) as Process;
    let ram=new Uint8Array(32),published:boolean|undefined;
    Object.assign(owner,{resetGeneration:7,addressSpace:{
        validateRange:(address:number,length:number)=>address>0&&address+length<=ram.length,
        write(address:number,bytes:Uint8Array){ram.set(bytes,address);return bytes.length;},
    }});
    const original=ram,writes=[{address:8,value:0x12345678,size:4 as const}];
    owner.enqueueCompletion(writes,value=>{published=value;},()=>true);
    writes[0].value=0;ram=new Uint8Array(64);await Promise.resolve();
    expect(published).toBe(true);
    expect(new DataView(ram.buffer).getUint32(8,true)).toBe(0x12345678);
    expect([...original]).toEqual(Array(32).fill(0));
});
