import type {Process} from '../core/process';
import type {ApcCallbackLifetime} from '../core/scheduler/types';
import {WsaFailure,WSA} from './wsa-network';

const owners=new WeakMap<Process,{generation:number;active:number}>();
const MAX_CONTROL_APCS=256;
/** A synchronous provider control APC exposes a separate zeroed internal OVERLAPPED. */
export function reserveControlApc(process:Process):ApcCallbackLifetime {
    let pool=owners.get(process);
    if(!pool||pool.generation!==process.resetGeneration){pool={generation:process.resetGeneration,active:0};owners.set(process,pool);}
    if(pool.active>=MAX_CONTROL_APCS)throw new WsaFailure(WSA.ENOBUFS);
    pool.active++;
    const owner=pool;let pointer=0,retired=false;
    const release=()=>{
        if(retired)return;
        retired=true;owner.active--;
        if(pointer&&process.resetGeneration===owner.generation)process.memory.free(pointer);
        pointer=0;
    };
    return {
        prepare(args){
            if(retired||process.resetGeneration!==owner.generation)return null;
            pointer=process.memory.alloc(20);
            if(!pointer)throw new WsaFailure(WSA.ENOBUFS);
            if(process.addressSpace.write(pointer,new Uint8Array(20))!==20){release();throw new WsaFailure(WSA.EFAULT);}
            return [args[0],0,pointer,args[3]??0];
        },
        onReturn:release,onDiscard:release,
    };
}
