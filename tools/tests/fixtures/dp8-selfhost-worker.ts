import {ChildProcessNetworkNamespace, type NetworkNamespaceBoot} from "../../../src/worker/core/network-namespace";
import {LanNetwork} from "../../../src/worker/net/lan-network";
import {DirectPlay8Session} from "../../../src/worker/modules/dpnet/peer";
import type {SessionDesc} from "../../../src/worker/modules/dplayx/session";
let namespace:ChildProcessNetworkNamespace;
const desc = (): SessionDesc => ({ instance: "0".repeat(32), application: "5102dacf241b11d3aea7006097b01411", flags: 0, maxPlayers: 8,
    name: "session", password: "", user: [0, 0, 0, 0], extended: { flags: 0, reserved: [], application: [1, 2] } as never } as SessionDesc);
self.onmessage = async event => {
    const command = event.data;
    try {
        if (command.type === "boot") {
            const boot: NetworkNamespaceBoot = command.boot;
            const network = new LanNetwork();
            namespace = new ChildProcessNetworkNamespace(network, boot);
            const host = new DirectPlay8Session(network, "peer");
            const client = new DirectPlay8Session(network, "peer");
            host.initialize(); client.initialize();
            const bindHr = host.bindPort(23913);
            const hostHr = host.host(desc());
            const node = network.routeIpv4(new Uint8Array([127, 0, 0, 1]));
            const discoverHr = (client as any).virtualProvider.discoverAt(desc().application, { node: Array.from(node), port: 23913 });
            await new Promise(r => setTimeout(r, 400));
            const found = [...(client as any).virtualProvider.discovered.values()].map((i: any) => ({ app: i.desc.application, port: i.address.port }));
            self.postMessage({ id: command.id, result: { bindHr, hostHr, discoverHr, found } });
        } else if (command.type === "close") {
            namespace?.close();
            self.postMessage({ id: command.id, result: { closed: true } });
        }
    } catch (error) { self.postMessage({ id: command.id, error: String((error as Error)?.stack ?? error) }); }
};
