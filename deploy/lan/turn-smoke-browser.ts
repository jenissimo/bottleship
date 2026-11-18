import { RoomCommsClient } from "../../src/app/room-comms-client";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { RelayLink } from "../../src/worker/net/relay-link";

const pcs: RTCPeerConnection[] = [];
const BrowserPeerConnection = window.RTCPeerConnection;
window.RTCPeerConnection = class extends BrowserPeerConnection {
    constructor(configuration?: RTCConfiguration) {
        const iceServers = configuration?.iceServers?.flatMap(server => {
            const urls = [server.urls].flat().filter(url => /^turns?:/.test(url));
            return urls.length ? [{ ...server, urls }] : [];
        }) ?? [];
        super({ ...configuration, iceServers, iceTransportPolicy: "relay" });
        pcs.push(this);
    }
};

const relayUrl = new URL(location.href).searchParams.get("relay")!;
function joinRoom() {
    const client = new RoomCommsClient(request => {
        if (!link.sendRoomComms(request)) throw new Error("LAN relay did not accept room action");
    });
    const link = new RelayLink(relayUrl, "turn-smoke", new LanNetwork(),
        { onRoomComms: update => client.receive(update) });
    return { client, link };
}

async function until(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for " + description);
}

async function mediaStats(pc: RTCPeerConnection) {
    const report = await pc.getStats();
    const rows = Array.from(report.values());
    const transport = rows.find(row => row.type === "transport" && row.selectedCandidatePairId);
    const pair = transport && report.get(transport.selectedCandidatePairId);
    const incoming = rows.find(row => row.type === "inbound-rtp" && row.kind === "audio");
    const outgoing = rows.find(row => row.type === "outbound-rtp" && row.kind === "audio");
    return {
        local: pair && report.get(pair.localCandidateId)?.candidateType,
        remote: pair && report.get(pair.remoteCandidateId)?.candidateType,
        relayProtocol: pair && report.get(pair.localCandidateId)?.relayProtocol,
        received: Number(incoming?.packetsReceived ?? 0),
        sent: Number(outgoing?.packetsSent ?? 0),
    };
}

const a = joinRoom();
const b = joinRoom();
try {
    await Promise.all([a.link.ready, b.link.ready]);
    a.client.chat("TURN smoke");
    await until(() => b.client.snapshot().messages[0]?.text === "TURN smoke", "room chat");
    await Promise.all([a.client.joinVoice(), b.client.joinVoice()]);
    await until(() => a.client.snapshot().connectedVoicePeers === 1
        && b.client.snapshot().connectedVoicePeers === 1, "two connected voice peers");
    await until(async () => {
        const stats = await Promise.all(pcs.map(mediaStats));
        return stats.length === 2 && stats.every(row =>
            row.local === "relay" && row.remote === "relay" && row.received > 3 && row.sent > 3);
    }, "a selected relay pair and bidirectional audio");
    await until(() => a.client.snapshot().relayedVoicePeers === 1
        && b.client.snapshot().relayedVoicePeers === 1, "relay status on both clients");
    const media = await Promise.all(pcs.map(mediaStats));
    const tracks = pcs.flatMap(pc => pc.getSenders().flatMap(sender => sender.track ?? []));
    a.client.toggleMute();
    if (!a.client.snapshot().muted || tracks.length !== 2
        || tracks.filter(track => !track.enabled).length !== 1) {
        throw new Error("Expected one muted microphone track");
    }
    a.client.leaveVoice();
    await until(() => a.client.snapshot().voice === "off" && b.client.snapshot().peers === 0,
        "voice leave and roster removal");
    if (tracks.filter(track => track.readyState === "ended").length !== 1) {
        throw new Error("Leaving voice did not stop the microphone");
    }
    document.body.textContent = JSON.stringify({ pass: true, media, chat: true, mute: true, leave: true });
} catch (error) {
    const peers = pcs.map(pc => ({ state: pc.connectionState, ice: pc.iceConnectionState,
        turnConfigured: Boolean(pc.getConfiguration().iceServers?.length) }));
    document.body.textContent = JSON.stringify({ pass: false, error: String(error), peers });
} finally {
    a.link.close();
    b.link.close();
}
