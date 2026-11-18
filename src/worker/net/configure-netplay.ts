import type { NetworkConfig } from "../../network-config";
import { getProcessNetworkNamespace } from "../core/process-network";
import { RootNetworkNamespace } from "../core/network-namespace";
import type { RoomCommsUpdate } from "../../../packages/lan/src/room-comms";
import { lanNetwork, type LanState } from "./lan-network";

let currentState: LanState = { connected: false, node: lanNetwork.node.slice(), ipv4: lanNetwork.ipv4, generation: 0 };
lanNetwork.onStateChange(state => { currentState = state; });
export function getNetplayState(): LanState {
    return { ...currentState, connected: lanNetwork.connected, node: lanNetwork.node.slice(), ipv4: lanNetwork.ipv4 };
}
export function configureNetplay(config: NetworkConfig | null, onRoomComms?: (update: RoomCommsUpdate) => void): Promise<void> {
    const owner = getProcessNetworkNamespace();
    return owner instanceof RootNetworkNamespace ? owner.configure(config, onRoomComms) : owner.configure(config);
}

export function sendRoomComms(request: unknown): boolean {
    const owner = getProcessNetworkNamespace();
    return owner instanceof RootNetworkNamespace && owner.sendRoomComms(request);
}
