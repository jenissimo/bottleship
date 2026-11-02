import type { LanNetwork } from "../../net/lan-network";
import { nodeToIpv4 } from "../../net/lan-network";
import { PROTO_UDP, isExternalIpv4Node, validPort } from "../../net/netplay-wire";
import type { Address } from "../dplayx/session";
import type { DirectPlay8HostProvider } from "./backend";
import { DirectPlayAddress } from "./address";

const ipv4Address = (address: Address): boolean => !!address && Array.isArray(address.node) && address.node.length === 6 &&
    address.node.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    isExternalIpv4Node(Uint8Array.from(address.node)) && validPort(address.port);

/** Explicit native policy; an absent listener capability never selects a virtual fallback. */
export function lanDirectPlay8HostProvider(network: LanNetwork): DirectPlay8HostProvider | undefined {
    const policy = network.directPlay8;
    if (policy?.provider !== "native") return undefined;
    return { async prepare(request) {
        const current = () => !request.signal.aborted && network.connected &&
            network.bindingGeneration(request.localPort, PROTO_UDP) === request.bindingGeneration &&
            request.localAddress.port === request.localPort && request.localAddress.node.every((n, i) => n === network.node[i]);
        if (!request.bindingGeneration || !current()) throw Error("Retired native Host binding");
        const lease = await network.openUdpHost(request.localPort, policy.hostListener, request.signal);
        let released = false;
        const release = () => { if (!released) { released = true; lease.release(); } };
        try {
            if (!current() || !lease.isLive() || !ipv4Address(lease.address) ||
                !Array.isArray(lease.allowedNodes) || !lease.allowedNodes.length || lease.allowedNodes.length > 4096)
                throw Error("Invalid native Host READY");
            const allowed = new Set<string>();
            for (const node of lease.allowedNodes) {
                if (!ipv4Address({ node, port: 1 })) throw Error("Invalid native Host ingress ACL");
                allowed.add(node.join("."));
            }
            const address = { node: lease.address.node.slice(), port: lease.address.port };
            const live = () => { try { return !released && current() && lease.isLive(); } catch { return false; } };
            return { address, isLive: live, closed: lease.closed, release,
                allowIncoming: source => live() && ipv4Address(source) && allowed.has(source.node.join(".")),
                url: source => {
                    if (!ipv4Address(source)) throw Error("Invalid native Host URL");
                    const value = new DirectPlayAddress();
                    value.buildHost(Array.from(nodeToIpv4(Uint8Array.from(source.node))).join("."), source.port);
                    return value.url();
                } };
        } catch (error) { release(); throw error; }
    } };
}
