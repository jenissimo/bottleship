import {WSA, WsaFailure, WsaSocketTable} from "../../wsa-network";

/** An owned native listener; not itself permission to send a Join. */
export interface DirectPlay4JoinListener {
    readonly socket: number;
    readonly ownerToken: number;
    readonly address: {readonly node: readonly number[]; readonly port: number};
    current(): boolean;
    release(): void;
}

/**
 * Acquire one native TCP listener through the caller's socket actor.
 * The gateway's TcpHost open enforces its configured listener ACL; this
 * function does not authorize any outbound destination or create UDP owner.
 * There is no virtual fallback. The signal retains ownership until release.
 */
export function acquireDirectPlay4JoinListener(
    table: WsaSocketTable, timeoutMs: number, signal?: AbortSignal,
): Promise<DirectPlay4JoinListener> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
        return Promise.reject(new RangeError("invalid listener timeout"));
    if (signal?.aborted) return Promise.reject(new Error("listener cancelled"));
    let policy: ReturnType<typeof getPolicy>;
    try { policy=getPolicy(table); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve,reject)=>{
        let state: "opening"|"ready"|"closed"="opening", socket=0, fileId=0, generation=-1, token=0;
        let unsubscribe=()=>{}, timer: ReturnType<typeof setTimeout>|undefined, queued=false, published=false, revision=0;
        let result: DirectPlay4JoinListener|undefined;
        const isClosed=()=>state==="closed";
        const exact=():boolean=>{
            try {return socket!==0 && table.generation===generation && table.isValid(socket) && table.fileObjectId(socket)===fileId;}
            catch {return false;}
        };
        const closeExact=()=>{
            try {if (exact()) table.closesocket(socket);} catch { /* owner may already be revoked */ }
        };
        const release=()=>{
            if(isClosed())return;
            state="closed"; unsubscribe(); signal?.removeEventListener("abort",abort);
            if(timer)clearTimeout(timer);
            closeExact();
            if(!published)reject(new Error("native listener cancelled"));
        };
        const abort=()=>release();
        const live=():boolean=>{
            if(state!=="ready")return false;
            try {
                const before=revision;
                if (!exact()) return false;
                const p=getPolicy(table);
                if (p.key!==policy.key || !table.nativeListenerCurrent(socket,token)) return false;
                // Actor identity is checked after policy sync. The final epoch
                // read is local and cannot reenter either network or actor.
                return state==="ready" && before===revision && table.network.tcpHostPolicyCurrentEpoch===p.epoch;
            } catch {return false;}
        };
        const wake=()=>{
            revision++;
            if(state==="closed"||queued)return;
            queued=true;setTimeout(()=>{queued=false;pump();},0);
        };
        const pump=()=>{
            if(isClosed())return;
            if(state==="ready") {if(!live())release();return;}
            try {
                if(!exact() || getPolicy(table).key!==policy.key)throw new Error("native listener owner retired");
                try {table.listen(socket,8,true,1);}
                catch(error) {if(error instanceof WsaFailure && error.code===WSA.EWOULDBLOCK)return;throw error;}
                if(state!=="opening" || !exact() || getPolicy(table).key!==policy.key)throw new Error("native listener owner retired");
                const snapshot=table.nativeListenerSnapshot(socket);
                if(!snapshot || !table.nativeListenerCurrent(socket,snapshot.ownerToken))throw new Error("native listener not ready");
                const address={node:Object.freeze([...snapshot.address.node]),port:snapshot.address.port};
                token=snapshot.ownerToken; state="ready";
                result=Object.freeze({socket,ownerToken:token,address:Object.freeze(address),current:live,release});
                if(!live())throw new Error("native listener retired during READY");
                if(timer)clearTimeout(timer);
                published=true; resolve(result);
            } catch(error) {
                if(isClosed())return;
                state="closed";unsubscribe();signal?.removeEventListener("abort",abort);
                if(timer)clearTimeout(timer);closeExact();
                // A failed post-READY check still has an unresolved promise.
                if(!published)reject(error);
            }
        };
        try {
            signal?.addEventListener("abort",abort,{once:true});
            if(signal?.aborted){abort();return;}
            socket=table.socket(1,2,6);
            generation=table.generation;fileId=table.fileObjectId(socket);
            if(isClosed()){closeExact();return;}
            table.bind(socket);
            if(isClosed()){closeExact();return;}
            unsubscribe=table.subscribe(wake);
            if(isClosed()){unsubscribe();closeExact();return;}
            timer=setTimeout(()=>release(),timeoutMs);
            if(signal?.aborted)abort();else pump();
        } catch(error) {
            if(isClosed()){closeExact();return;}
            state="closed";unsubscribe();signal?.removeEventListener("abort",abort);
            if(timer)clearTimeout(timer);closeExact();reject(error);
        }
    });
}

function getPolicy(table: WsaSocketTable): {key:string;epoch:object} {
    const snapshot=table.network.tcpHostPolicySnapshot(), policy=snapshot.winsock, capability=snapshot.capability;
    if(!snapshot.connected || policy?.provider!=="native" || !policy.hostListener)
        throw new Error("native listener policy unavailable");
    const listener=capability?.listeners.find(item=>item.id===policy.hostListener);
    if(!listener) throw new Error("native listener policy unavailable");
    // The same listener id may be re-advertised with a different ACL.
    const acl=listener.allowedNodes.map(node=>node.join(".")).sort();
    return {key:JSON.stringify([policy.hostListener,acl]),epoch:snapshot.epoch};
}
