import {getProcessIdentity} from "./process-identity";
import { lanNetwork } from "../net/lan-network";
import { ChildProcessNetworkNamespace, RootNetworkNamespace, type NetworkNamespaceBoot, type ProcessNetworkNamespace, type ChildNetworkNamespace } from "./network-namespace";

let namespace: ProcessNetworkNamespace | null = null;
export function getProcessNetworkNamespace(): ProcessNetworkNamespace {
    return namespace ??= new RootNetworkNamespace(lanNetwork,256,getProcessIdentity().pid);
}
export function adoptProcessNetworkNamespace(boot: NetworkNamespaceBoot): void {
    if (namespace) throw new Error("A process network namespace has already been initialized");
    namespace = new ChildProcessNetworkNamespace(lanNetwork, boot);
}
export function createChildNetworkNamespace(pid?:number): ChildNetworkNamespace { return getProcessNetworkNamespace().createChild(pid); }
export function beginProcessNetworkLifetime():void{getProcessNetworkNamespace().beginProcessLifetime();}
/** Graceful guest exit closes actor aliases before draining the service transport. */
export function finishProcessNetworkLifetime():Promise<void>{return namespace?.finishProcessLifetime()??Promise.resolve();}
export function getSocketActorClient(){return getProcessNetworkNamespace().socketActorClient();}
/** Guest exit releases actor references while child/service namespace leases survive. */
export function dropSocketActorClient():void{namespace?.dropSocketActorClient();}
/** Orders normal process exit after its previously accepted network frames. */
export function flushProcessNetworkNamespace(): Promise<void> { return namespace?.barrier() ?? Promise.resolve(); }
export async function closeProcessNetworkNamespace(): Promise<void> {const current=namespace;namespace=null;await current?.close();}
export type { NetworkNamespaceBoot } from "./network-namespace";
