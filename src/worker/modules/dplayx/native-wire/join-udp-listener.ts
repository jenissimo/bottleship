import {WsaSocketTable} from "../../wsa-network";

type Snapshot={address:{node:number[];port:number};allowedNodes:number[][];port:number;binding:number;physical:number};
type ActorHandle={inspect():Snapshot|null;release():void};
type ActorTable=WsaSocketTable&{startActorUdpHost(socket:number,listener:string):ActorHandle};
export interface DirectPlay4JoinUdpListener {
    readonly socket:number; readonly physical:number; readonly binding:number;
    readonly address:{readonly node:readonly number[];readonly port:number};
    readonly allowedNodes:readonly (readonly number[])[];
    current():boolean; release():void;
}
/** Explicit actor-owned UDP host binding; no implicit fallback or Join publication. */
export function acquireDirectPlay4JoinUdpListener(table:WsaSocketTable,listener:string,timeoutMs:number,signal?:AbortSignal):Promise<DirectPlay4JoinUdpListener>{
    if(typeof listener!=="string"||!/^[A-Za-z0-9_-]{1,64}$/.test(listener)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)
        return Promise.reject(new RangeError("invalid UDP listener request"));
    const actor=table as ActorTable;
    if(typeof actor.startActorUdpHost!=="function")return Promise.reject(new Error("actor UDP Host unavailable"));
    if(signal?.aborted)return Promise.reject(new Error("UDP listener cancelled"));
    return new Promise((resolve,reject)=>{
        let socket=0, generation=-1,fileId=0, operation:ActorHandle|undefined, closed=false,published=false;
        let unsubscribe=()=>{},timer:ReturnType<typeof setTimeout>|undefined,queued=false;
        let result:DirectPlay4JoinUdpListener|undefined, binding=0;
        const exact=()=>{try{return !!socket&&table.generation===generation&&table.isValid(socket)&&table.fileObjectId(socket)===fileId;}catch{return false;}};
        const release=()=>{
            if(closed)return;closed=true;unsubscribe();signal?.removeEventListener("abort",abort);if(timer)clearTimeout(timer);
            try{operation?.release();}catch{}
            try{if(exact())table.closesocket(socket);}catch{}
            if(!published)reject(new Error("UDP listener cancelled"));
        };
        const abort=()=>release();
        const inspect=():Snapshot|null=>{
            if(closed||!operation||!exact())return null;
            const ready=operation.inspect();
            if(!ready)return null;
            // inspect is the final actor call: it validates exact alias, binding,
            // lease and policy inside the owning actor generation.
            if(closed||ready.physical!==fileId||!Number.isInteger(ready.binding)||ready.binding<1||
                (binding!==0&&binding!==ready.binding))return null;
            return ready;
        };
        const current=()=>{try{return !!published&&!!inspect();}catch{return false;}};
        const pump=()=>{
            if(closed)return;
            try {
                const ready=inspect();if(!ready){if(published)release();return;}
                if(published)return;
                binding=ready.binding;
                const address=Object.freeze({node:Object.freeze([...ready.address.node]),port:ready.address.port});
                const allowedNodes=Object.freeze(ready.allowedNodes.map(node=>Object.freeze([...node])));
                result=Object.freeze({socket,physical:fileId,binding,address,allowedNodes,current,release});
                if(closed||!inspect())throw new Error("UDP listener retired during READY");
                if(timer)clearTimeout(timer);published=true;resolve(result);
            } catch(e){if(closed)return;release();reject(e);}
        };
        const wake=()=>{if(closed||queued)return;queued=true;setTimeout(()=>{queued=false;pump();},0);};
        try {
            signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted){abort();return;}
            socket=table.socket(2,2,17);generation=table.generation;fileId=table.fileObjectId(socket);
            if(closed){try{if(exact())table.closesocket(socket);}catch{}return;}
            table.bind(socket);
            if(closed){try{if(exact())table.closesocket(socket);}catch{}return;}
            unsubscribe=table.subscribe(wake);
            if(closed){unsubscribe();try{if(exact())table.closesocket(socket);}catch{}return;}
            operation=actor.startActorUdpHost(socket,listener);
            if(closed){operation.release();return;}
            timer=setTimeout(release,timeoutMs);if(signal?.aborted)abort();else pump();
        } catch(e){if(!closed){release();reject(e);}}
    });
}
