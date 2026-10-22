import type { NetworkConfig } from "../../network-config";
import { getProcessNetworkNamespace } from "../core/process-network";
import { lanNetwork, type LanState } from "./lan-network";

let currentState: LanState = { connected: false, node: lanNetwork.node.slice(), ipv4: lanNetwork.ipv4, generation: 0 };
lanNetwork.onStateChange(state => { currentState = state; });
export function getNetplayState(): LanState {
    return { ...currentState, connected: lanNetwork.connected, node: lanNetwork.node.slice(), ipv4: lanNetwork.ipv4 };
}
export function configureNetplay(config: NetworkConfig | null): Promise<void> {
    return getProcessNetworkNamespace().configure(config);
}
