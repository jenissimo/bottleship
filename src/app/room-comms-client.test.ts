/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { RoomCommsClient } from "./room-comms-client";
import type { RoomCommsRequest, RoomIceCredentials } from "../../packages/lan/src/room-comms";

const SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const AVAILABLE = { kind: "available", enabled: true };
const SUSPENDED = { kind: "available", enabled: false, recovering: true };
const CLOSED = { kind: "available", enabled: false };
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

class AudioTrack extends EventTarget {
    readonly kind = "audio";
    enabled = true;
    stopped = false;

    stop(): void { this.stopped = true; }
}

class Stream {
    constructor(private readonly tracks = [new AudioTrack()]) {}

    getTracks(): AudioTrack[] { return this.tracks; }
    getAudioTracks(): AudioTrack[] { return this.tracks; }
}

class AudioElement {
    srcObject: Stream | null = null;
    paused = false;
    static needsGesture = false;
    static instances: AudioElement[] = [];

    constructor() { AudioElement.instances.push(this); }
    play(): Promise<void> {
        return AudioElement.needsGesture ? Promise.reject(new DOMException("", "NotAllowedError")) : Promise.resolve();
    }
    pause(): void { this.paused = true; }
}

class PeerConnection {
    onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    ontrack: ((event: { track: AudioTrack }) => void) | null = null;
    connectionState: RTCPeerConnectionState = "new";
    iceConnectionState: RTCIceConnectionState = "new";
    remoteDescription?: RTCSessionDescriptionInit;
    localDescription?: RTCSessionDescriptionInit;
    track?: AudioTrack;
    offers = 0;
    answers = 0;
    updatedConfigurations = 0;
    offerResult?: Promise<RTCSessionDescriptionInit>;
    stats?: Promise<RTCStatsReport>;
    static instances: PeerConnection[] = [];

    constructor(private config: RTCConfiguration) { PeerConnection.instances.push(this); }
    close(): void { this.connectionState = "closed"; }
    addTrack(track: AudioTrack): void { this.track = track; }
    getConfiguration(): RTCConfiguration { return this.config; }
    setConfiguration(config: RTCConfiguration): void {
        this.config = config;
        this.updatedConfigurations++;
    }
    async createOffer(): Promise<RTCSessionDescriptionInit> {
        this.offers++;
        return this.offerResult ?? { type: "offer", sdp: SDP };
    }
    async createAnswer(): Promise<RTCSessionDescriptionInit> {
        this.answers++;
        return { type: "answer", sdp: SDP };
    }
    async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> { this.localDescription = description; }
    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> { this.remoteDescription = description; }
    async addIceCandidate(): Promise<void> {}
    getStats(): Promise<RTCStatsReport> { return this.stats ?? Promise.resolve(routeStats("host", "srflx")); }

    transition(state: RTCPeerConnectionState, iceState: RTCIceConnectionState): void {
        this.connectionState = state;
        this.iceConnectionState = iceState;
        this.onconnectionstatechange?.();
    }
}

function routeStats(local: string, remote: string): RTCStatsReport {
    return new Map([
        ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
        ["pair", { type: "candidate-pair", localCandidateId: "local", remoteCandidateId: "remote" }],
        ["local", { type: "local-candidate", candidateType: local }],
        ["remote", { type: "remote-candidate", candidateType: remote }],
    ]) as RTCStatsReport;
}

const globals = ["navigator", "MediaStream", "RTCPeerConnection", "Audio"] as const;
const originals = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
let obtainMic: () => Promise<Stream>;
let mic: Stream;
let sent: RoomCommsRequest[];
let client: RoomCommsClient;

beforeEach(() => {
    mic = new Stream();
    obtainMic = async () => mic;
    const values = [{ mediaDevices: { getUserMedia: () => obtainMic() } }, Stream, PeerConnection, AudioElement];
    globals.forEach((name, index) => Object.defineProperty(globalThis, name, { configurable: true, value: values[index] }));
    sent = [];
    PeerConnection.instances = [];
    AudioElement.instances = [];
    AudioElement.needsGesture = false;
    client = new RoomCommsClient(request => { sent.push(request); });
    client.receive(AVAILABLE);
});

afterEach(() => {
    client.reset();
    globals.forEach((name, index) => {
        const original = originals[index];
        if (original) Object.defineProperty(globalThis, name, original);
        else Reflect.deleteProperty(globalThis, name);
    });
});

function roster(self: string, peers: string[], ice?: RoomIceCredentials): void {
    client.receive({ kind: "voice", self, peers, ice });
}

function offer(from: string, to: string): void {
    client.receive({ kind: "signal", from, to, payload: JSON.stringify({ description: { type: "offer", sdp: SDP } }) });
}

function ticket(id: number): RoomIceCredentials {
    return {
        urls: ["turn:relay.example.test:3478?transport=udp", "turns:relay.example.test:5349?transport=tcp"],
        username: `${1_955_000_000 + id}:voice123`,
        credential: `zXAyTuC5Y40L2uaDJ1hkzlrh5l${id === 1 ? "Q" : "A"}=`,
        expiresAt: (1_955_000_000 + id) * 1000,
    };
}

test("uses admitted TURN tickets alongside direct ICE and reports the selected media routes", async () => {
    await client.joinVoice();
    roster("a", ["b", "c"], ticket(1));
    const [direct, relay] = PeerConnection.instances;
    for (const peer of [direct, relay]) {
        const config = peer.getConfiguration();
        expect(config.iceTransportPolicy ?? "all").toBe("all");
        expect(config.iceServers).toContainEqual({
            urls: ticket(1).urls, username: ticket(1).username, credential: ticket(1).credential,
        });
    }
    relay.stats = Promise.resolve(routeStats("srflx", "relay"));
    direct.transition("connected", "completed");
    relay.transition("connected", "completed");
    await flush();
    expect(client.snapshot()).toMatchObject({ connectedVoicePeers: 2, directVoicePeers: 1, relayedVoicePeers: 1 });
    expect(JSON.stringify(client.snapshot())).not.toContain(ticket(1).credential);

    roster("a", ["b", "c", "d"], ticket(2));
    expect(PeerConnection.instances).toHaveLength(3);
    for (const peer of PeerConnection.instances) expect(peer.getConfiguration().iceServers).toContainEqual({
        urls: ticket(2).urls, username: ticket(2).username, credential: ticket(2).credential,
    });
    expect(direct.updatedConfigurations).toBe(1);
    expect(direct.connectionState).toBe("connected");
    roster("a", ["b", "c", "d"], ticket(2));
    expect(direct.updatedConfigurations).toBe(1);
    roster("a", ["b", "c", "d"]);
    expect(direct.getConfiguration().iceServers?.some(server => server.credential)).toBe(false);
});

test("the answerer can recover with a new identity, ignores old messages and stops after repeated failure", async () => {
    await client.joinVoice();
    roster("z", ["b"], ticket(1));
    const [original] = PeerConnection.instances;
    offer("b", "z");
    await flush();
    expect(original.answers).toBe(1);
    expect(original.offers).toBe(0);
    original.transition("connected", "completed");
    client.toggleMute();
    original.transition("failed", "failed");
    expect(original.connectionState).toBe("closed");
    expect(sent.slice(-2)).toEqual([{ kind: "voiceLeave" }, { kind: "voiceJoin" }]);
    expect(client.snapshot()).toMatchObject({ voice: "reconnecting", muted: true });

    roster("z", ["b"], ticket(1));
    offer("b", "z");
    expect(PeerConnection.instances).toHaveLength(1);
    roster("a", ["b"], ticket(2));
    offer("b", "z");
    await flush();
    const replacement = PeerConnection.instances[1];
    expect(replacement.offers).toBe(1);
    expect(replacement.answers).toBe(0);
    expect(replacement.getConfiguration().iceServers?.some(server => server.credential === ticket(2).credential)).toBe(true);
    expect(replacement.track?.enabled).toBe(false);
    replacement.transition("failed", "failed");
    expect(sent.filter(request => request.kind === "voiceJoin")).toHaveLength(2);
    expect(client.snapshot()).toMatchObject({ voice: "off", notice: expect.stringContaining("Could not reconnect voice") });
    expect(mic.getTracks()[0].stopped).toBe(true);
});

test("temporary relay loss keeps consent and history for the same link and terminal close drops both", async () => {
    client.receive({ kind: "chat", sender: "10.10.0.3", text: "Keep this room's message" });
    await client.joinVoice();
    roster("a", ["b"], ticket(1));
    const track = mic.getTracks()[0];
    const [original] = PeerConnection.instances;
    original.transition("connected", "completed");
    expect(track.enabled).toBe(true);

    client.receive(SUSPENDED);
    expect(track.enabled).toBe(false);
    expect(track.stopped).toBe(false);
    expect(original.connectionState).toBe("closed");
    expect(client.snapshot()).toMatchObject({ available: false, relayReconnecting: true, voice: "reconnecting" });
    expect(client.chat("Do not send while offline")).toBe(false);
    client.toggleMute();
    client.receive(AVAILABLE);
    client.receive(AVAILABLE);
    expect(sent.filter(request => request.kind === "voiceJoin")).toHaveLength(2);
    expect(track.enabled).toBe(false);
    roster("c", []);
    expect(client.snapshot()).toMatchObject({ voice: "joined", muted: true, messages: [{ text: "Keep this room's message" }] });
    client.toggleMute();
    expect(track.enabled).toBe(true);

    client.receive(SUSPENDED);
    client.receive(CLOSED);
    expect(track.stopped).toBe(true);
    expect(client.snapshot()).toMatchObject({ voice: "off", available: false, relayReconnecting: false, messages: [] });
    client.receive(AVAILABLE);
    expect(sent.filter(request => request.kind === "voiceJoin")).toHaveLength(2);
});

test("leave or room reset cancels a pending permission and an in-flight local offer", async () => {
    const permission = Promise.withResolvers<Stream>();
    obtainMic = () => permission.promise;
    const joining = client.joinVoice();
    client.receive(CLOSED);
    permission.resolve(mic);
    await joining;
    expect(mic.getTracks()[0].stopped).toBe(true);
    expect(sent).toHaveLength(0);

    client.receive(AVAILABLE);
    mic = new Stream();
    obtainMic = async () => mic;
    await client.joinVoice();
    roster("a", ["b"]);
    const deferredOffer = Promise.withResolvers<RTCSessionDescriptionInit>();
    const [peer] = PeerConnection.instances;
    peer.offerResult = deferredOffer.promise;
    await flush();
    expect(peer.offers).toBe(1);
    client.leaveVoice();
    deferredOffer.resolve({ type: "offer", sdp: SDP });
    await flush();
    expect(peer.localDescription).toBeUndefined();
    expect(sent).toEqual([{ kind: "voiceJoin" }, { kind: "voiceLeave" }]);
    expect(mic.getTracks()[0].stopped).toBe(true);
});

test("autoplay rejection is recoverable and a departing peer releases audio and stale stats", async () => {
    await client.joinVoice();
    roster("a", ["b"]);
    const [peer] = PeerConnection.instances;
    const route = Promise.withResolvers<RTCStatsReport>();
    peer.stats = route.promise;
    peer.transition("connected", "completed");
    AudioElement.needsGesture = true;
    peer.ontrack?.({ track: new AudioTrack() });
    await flush();
    expect(client.snapshot().playbackBlocked).toBe(true);
    AudioElement.needsGesture = false;
    client.resumePlayback();
    await flush();
    expect(client.snapshot().playbackBlocked).toBe(false);

    roster("a", []);
    route.resolve(routeStats("relay", "host"));
    await flush();
    expect(AudioElement.instances[0]).toMatchObject({ paused: true, srcObject: null });
    expect(client.snapshot()).toMatchObject({ peers: 0, relayedVoicePeers: 0, playbackBlocked: false });
});
