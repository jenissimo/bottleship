import type { HarnessService } from "../service";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { getNetplayState } from "../../net/configure-netplay";
import { lanNetwork } from "../../net/lan-network";
import { processIpcState } from "../../core/process-ipc";
import { describeDirectPlay } from "../../modules/dplayx/network-api";

export function registerNetworkCommands(service: HarnessService): void {
    service.register("processIpcState", () => processIpcState());
    /** DirectPlay 1-4 sessions of this process: roster (players, groups, members, owner) and queue. */
    service.register("dplayState", () => ({ objects: describeDirectPlay() }));
    service.register("networkState", () => {
        const state = getNetplayState();
        return {
            config: EmulatorConfig.getInstance().network,
            connected: state.connected,
            address: state.ipv4.join("."),
            node: Array.from(state.node),
            generation: state.generation,
            reason: state.reason,
            packets: { ...lanNetwork.stats },
        };
    });
}
