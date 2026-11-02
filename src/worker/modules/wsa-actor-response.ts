import {WSA_ACTOR_DONE,WSA_ACTOR_ERROR,encodeActorValue,type WsaActorIdentity} from "./wsa-actor-protocol";

/** Encode one mailbox reply; retire an unpublished owned alias on failure. */
export function encodeWsaActorResponse(
    kernel:{execute(identity:WsaActorIdentity,command:string,args:unknown[]):unknown;drop(identity:WsaActorIdentity):void},
    identity:WsaActorIdentity,command:string,result:unknown,status:number,maxBytes:number,
    encode:(value:unknown)=>string=encodeActorValue,
): {status:number;bytes:Uint8Array} {
    try {
        const bytes=new TextEncoder().encode(encode(result));
        if(bytes.length<=maxBytes)return {status,bytes};
    } catch { /* Unserializable result cannot be published. */ }
    if(status===WSA_ACTOR_DONE && (command==="socketOwned"||command==="acceptOwned")) {
        const handle=(result as {handle?:unknown})?.handle;
        if(typeof handle!=="number" || !Number.isInteger(handle))kernel.drop(identity);
        else try {kernel.execute(identity,"closesocket",[handle]);}
        catch {kernel.drop(identity);}
    }
    return {status:WSA_ACTOR_ERROR,bytes:new TextEncoder().encode('{"error":10055}')};
}
