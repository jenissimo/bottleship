import { LanNetwork } from "../net/lan-network";
import { ChildProcessNetworkNamespace, readNetworkNamespaceProcesses, isNetworkNamespaceProcessLive, type NetworkNamespaceBoot } from "../core/network-namespace";
import { WsaSocketTable, WsaFailure, WsaUdpReceiveFailure, WSA } from "./wsa-network";
import { WsaActorKernel } from "./wsa-actor-kernel";
import { encodeWsaActorResponse } from "./wsa-actor-response";
import { WSA_ACTOR_MAILBOX_BYTES, WSA_ACTOR_HEADER_BYTES, WSA_ACTOR_PENDING, WSA_ACTOR_EXECUTING, WSA_ACTOR_DONE, WSA_ACTOR_ERROR, actorRequestFits, copyActorUdpReceiveError, type WsaActorIdentity, type WsaActorRequest } from "./wsa-actor-protocol";
let started = false;
function start(network: NetworkNamespaceBoot, control: MessagePort): void {
    const lan = new LanNetwork(), namespace = new ChildProcessNetworkNamespace(lan, network), kernel = new WsaActorKernel(new WsaSocketTable(lan));
    let closing = false;
    const clients = new Map<number, { identity: WsaActorIdentity; port: MessagePort }>();
    const reconcile = () => {
        kernel.reconcile(readNetworkNamespaceProcesses(network.shared, network.capacity));
    };
    const request = (identity: WsaActorIdentity, message: WsaActorRequest) => {
        if (!message || message.type !== "request" || !(message.mailbox instanceof SharedArrayBuffer) || message.mailbox.byteLength !== WSA_ACTOR_MAILBOX_BYTES) return;
        const header = new Int32Array(message.mailbox, 0, WSA_ACTOR_HEADER_BYTES / 4);
        if (Atomics.compareExchange(header, 0, WSA_ACTOR_PENDING, WSA_ACTOR_EXECUTING) !== WSA_ACTOR_PENDING) return;
        let status = WSA_ACTOR_DONE, result: unknown;
        try {
            if (closing) throw new WsaFailure(WSA.ENETDOWN);
            if (typeof message.command !== "string" || (message.nativeHandleOnly !== undefined && typeof message.nativeHandleOnly !== "boolean") || !actorRequestFits(message.args) || !Array.isArray(message.routes ?? []) || (message.routes?.length ?? 0)>1 || !actorRequestFits(message.routes ?? [])) throw new WsaFailure(WSA.EINVAL);
            reconcile();
            if (!isNetworkNamespaceProcessLive(network.shared, network.capacity, identity)) throw new WsaFailure(WSA.EACCES);
            for(const route of message.routes??[]) {
                if(!(route.address instanceof Uint8Array)||!(route.node instanceof Uint8Array)||route.node.length!==6||route.node[0]!==2||
                    (route.node[1]!==1&&route.node[1]!==2)||!Number.isInteger(route.scopeId??0)||(route.scopeId??0)<0||(route.scopeId??0)>0xffffffff)throw new WsaFailure(WSA.EINVAL);
                if(route.family===2&&route.address.length===4&&route.node[1]===1&&route.address.every((v,i)=>v===route.node[i+2]))lan.registerGatewayAddresses([[...route.address]]);
                else if(route.family===23&&route.address.length===16&&route.node[1]===2)lan.registerGatewayIpv6([{address:[...route.address],node:[...route.node],scopeId:route.scopeId??0}]);
                else if(route.family===23&&route.address.length===16&&route.node[1]===1&&route.address.subarray(0,10).every(v=>v===0)&&route.address[10]===255&&route.address[11]===255&&route.address.subarray(12).every((v,i)=>v===route.node[i+2]))lan.registerGatewayAddresses([[...route.address.subarray(12)]]);
                else throw new WsaFailure(WSA.EINVAL);
            }
            result = kernel.execute(identity, message.command, message.args, message.nativeHandleOnly ?? false);
        } catch (error) {
            status = WSA_ACTOR_ERROR;
            if (error instanceof WsaUdpReceiveFailure) {
                const from = error.from, address = from.family === 2 ? from.ip : from.ip6;
                const udpReceive = address && copyActorUdpReceiveError({
                    version: 1, family: from.family, address: Array.from(address), node: Array.from(from.node), port: from.port,
                    ...(from.family === 23 ? { scopeId: from.scopeId ?? 0, flowInfo: from.flowInfo ?? 0 } : {}),
                });
                result = udpReceive ? { error: error.code, udpReceive } : { error: WSA.ENOBUFS };
            } else result = { error: error instanceof WsaFailure ? error.code : WSA.ENOBUFS };
        }
        // Do not publish a failed serialization of an owned socket.
        const encoded=encodeWsaActorResponse(kernel,identity,message.command,result,status,message.mailbox.byteLength-WSA_ACTOR_HEADER_BYTES);
        status=encoded.status;const bytes=encoded.bytes;
        new Uint8Array(message.mailbox, WSA_ACTOR_HEADER_BYTES, bytes.length).set(bytes);
        Atomics.store(header, 1, bytes.length); Atomics.store(header, 0, status); Atomics.notify(header, 0);
    };
    control.onmessage = async ({ data }) => {
        if(data?.type==="shutdown"&&Number.isInteger(data.id)) {
            if(closing)return;
            closing=true;
            let error:string|undefined;
            try{kernel.reconcile([]);await namespace.barrier();}catch(reason){error=String(reason);}
            finally{
                namespace.close();
                for(const client of clients.values())client.port.close();clients.clear();
                control.postMessage({type:"shutdownDone",id:data.id,...(error?{error}:{})});
                if(typeof self.close === "function") self.close();
            }
            return;
        }
        if(closing){if(data?.port instanceof MessagePort)data.port.close();return;}
        if(data?.type==="barrier"&&Number.isInteger(data.id)) {
            try{await namespace.barrier();control.postMessage({type:"barrierDone",id:data.id});}
            catch(error){control.postMessage({type:"barrierDone",id:data.id,error:String(error)});}return;
        }
        if (!data || !Number.isInteger(data.pid) || !Number.isInteger(data.slot) || !Number.isInteger(data.epoch)) return;
        const identity = { pid: data.pid, slot: data.slot, epoch: data.epoch };
        reconcile(); // SAB lifetime is authoritative even when control events arrive out of order.
        if(data.type==="finish"&&Number.isInteger(data.id)) {
            try{kernel.drop(identity,false);await namespace.barrier();control.postMessage({type:"finished",id:data.id});}
            catch(error){control.postMessage({type:"finished",id:data.id,error:String(error)});}return;
        }
        if (data.type === "process") { if (isNetworkNamespaceProcessLive(network.shared, network.capacity, identity)) { try { kernel.register(identity); } catch {} } }
        else if (data.type === "drop") {
            kernel.drop(identity); const previous = clients.get(identity.pid);
            if (previous && previous.identity.epoch === identity.epoch && previous.identity.slot === identity.slot) { previous.port.close(); clients.delete(identity.pid); }
        } else if (data.type === "client" && data.port instanceof MessagePort) {
            const port: MessagePort = data.port;
            try { reconcile(); kernel.attach(identity, message => { try { port.postMessage(message); } catch { /* A stale completion channel cannot kill shared sockets. */ } }); } catch { port.close(); return; }
            clients.get(identity.pid)?.port.close(); clients.set(identity.pid, { identity, port });
            port.onmessage = ({ data }) => request(identity, data); port.start();
        }
    }; control.start();
    // Retain the namespace for this worker's lifetime. Guest exits remove aliases, never this lease.
    void namespace;
}
self.onmessage = ({ data }) => {
    if (started || data?.type !== "boot" || !data.network || !(data.control instanceof MessagePort)) return;
    started = true; start(data.network, data.control);
};
