import {
    readRoomCommsEvent, readRoomCommsRequest, ROOM_VOICE_LIMIT,
    type RoomCommsRequest, type RoomIceCredentials,
} from "../../packages/lan/src/room-comms";

type ChatLine = { id: number; sender: string; text: string };
type VoicePhase = "off" | "joining" | "joined" | "reconnecting";
type VoiceRoute = "direct" | "relay";
type RoomState = {
    available: boolean;
    relayReconnecting: boolean;
    messages: ChatLine[];
    voice: VoicePhase;
    muted: boolean;
    peers: number;
    connectedVoicePeers: number;
    directVoicePeers: number;
    relayedVoicePeers: number;
    failedVoicePeers: number;
    playbackBlocked: boolean;
    notice: string;
};

type Signal =
    | { description: { type: "offer" | "answer"; sdp: string } }
    | { candidate: RTCIceCandidateInit };
type Peer = {
    pc: RTCPeerConnection;
    audio?: HTMLAudioElement;
    local: RTCIceCandidateInit[];
    remote: RTCIceCandidateInit[];
    published: boolean;
    sentCandidates: number;
    receivedDescription: boolean;
    receivedCandidates: number;
    tasks: Promise<void>;
    deadline?: ReturnType<typeof setTimeout>;
    failed: boolean;
    playbackBlocked: boolean;
    playAttempt: number;
    route?: VoiceRoute;
    readingRoute: boolean;
};

const NO_PEERS = {
    peers: 0,
    connectedVoicePeers: 0,
    directVoicePeers: 0,
    relayedVoicePeers: 0,
    failedVoicePeers: 0,
    playbackBlocked: false,
};
const START: RoomState = {
    available: false, relayReconnecting: false, messages: [], voice: "off", muted: false, notice: "",
    ...NO_PEERS,
};
const HEARTBEAT_MS = 5_000;
const ROSTER_TIMEOUT_MS = 16_000;
const RELAY_RECONNECT_MS = 20_000;
const PEER_CONNECT_MS = 20_000;
const PEER_DISCONNECT_MS = 4_000;
const MEMBERSHIP_RETRY_COOLDOWN_MS = 60_000;
const MAX_CANDIDATES = 32;

// Operators can override STUN or disable it for LAN-only use.
const stunUrl = import.meta.env?.VITE_ROOM_VOICE_STUN_URL ?? "stun:stun.l.google.com:19302";

function parseSignal(payload: string): Signal | undefined {
    try {
        const value = JSON.parse(payload);
        const description = value?.description;
        if ((description?.type === "offer" || description?.type === "answer")
            && typeof description.sdp === "string"
            && /^m=audio /m.test(description.sdp)
            && (description.sdp.match(/^m=/gm)?.length === 1)) {
            return { description: { type: description.type, sdp: description.sdp } };
        }
        const candidate = value?.candidate;
        if (typeof candidate?.candidate === "string" && candidate.candidate.length <= 2048
            && (candidate.sdpMid == null || (typeof candidate.sdpMid === "string" && candidate.sdpMid.length <= 64))
            && (candidate.sdpMLineIndex == null || candidate.sdpMLineIndex === 0)
            && (candidate.sdpMid != null || candidate.sdpMLineIndex != null)) {
            return { candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex } };
        }
    } catch { /* Ignore malformed signaling. */ }
}

type IceStats = RTCStats & {
    selectedCandidatePairId?: string;
    selected?: boolean;
    localCandidateId?: string;
    remoteCandidateId?: string;
    candidateType?: string;
};

function selectedVoiceRoute(report: RTCStatsReport): VoiceRoute | undefined {
    const rows = Array.from(report.values()) as IceStats[];
    const pairId = rows.find(row => row.type === "transport" && row.selectedCandidatePairId)?.selectedCandidatePairId;
    const pair = pairId ? report.get(pairId) as IceStats | undefined
        : rows.find(row => row.type === "candidate-pair" && row.selected === true);
    if (!pair?.localCandidateId || !pair.remoteCandidateId) return;
    const local = (report.get(pair.localCandidateId) as IceStats | undefined)?.candidateType;
    const remote = (report.get(pair.remoteCandidateId) as IceStats | undefined)?.candidateType;
    if (local === "relay" || remote === "relay") return "relay";
    if (local && remote) return "direct";
}

function connected(peer: Peer): boolean {
    return peer.pc.connectionState === "connected"
        && peer.pc.iceConnectionState !== "disconnected" && peer.pc.iceConnectionState !== "failed";
}

export class RoomCommsClient {
    private state = START;
    private readonly listeners = new Set<() => void>();
    private readonly connections = new Map<string, Peer>();
    private stream?: MediaStream;
    private self: string | null = null;
    private previousSelf: string | null = null;
    private ice?: RoomIceCredentials;
    private nextMessage = 0;
    private epoch = 0;
    private lastRoster = 0;
    private lastRetry = -Infinity;
    private heartbeat?: ReturnType<typeof setInterval>;
    private relayDeadline?: ReturnType<typeof setTimeout>;

    constructor(private readonly send: (request: RoomCommsRequest) => void) {}

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    snapshot = () => this.state;

    private set(update: Partial<RoomState>): void {
        this.state = { ...this.state, ...update };
        for (const listener of this.listeners) listener();
    }

    receive(value: unknown): void {
        if (value && typeof value === "object" && "kind" in value && value.kind === "available") {
            if ("enabled" in value && value.enabled === true) {
                if (!this.state.available) {
                    clearTimeout(this.relayDeadline);
                    this.set({ available: true, relayReconnecting: false });
                    if (this.stream) this.beginMembership(false);
                }
            } else if ("recovering" in value && value.recovering === true) {
                if (this.state.available) this.suspend();
            } else this.reset();
            return;
        }
        if (!this.state.available) return;
        const event = readRoomCommsEvent(value);
        switch (event?.kind) {
            case "chat":
                this.set({ messages: [...this.state.messages.slice(-99),
                    { id: ++this.nextMessage, sender: event.sender, text: event.text }] });
                break;
            case "voice":
                if (event.self && this.stream) this.roster(event.self, event.peers, event.ice);
                break;
            case "signal":
                if (event.to === this.self) this.signal(event.from, event.payload);
                break;
            case "error":
                if (event.code === "voiceFull") {
                    if (!this.stream) return;
                    this.leaveVoice();
                    this.set({ notice: `Voice is full (${ROOM_VOICE_LIMIT} players).` });
                } else this.set({ notice: event.code === "chatRate" ? "You are sending messages too quickly." : "Connection busy. Try again." });
                break;
        }
    }

    chat(text: string): boolean {
        if (!this.state.available) return false;
        const request = readRoomCommsRequest({ kind: "chat", text });
        if (!request) {
            this.set({ notice: "Enter a message of up to 512 bytes." });
            return false;
        }
        this.set({ notice: "" });
        this.send(request);
        return true;
    }

    async joinVoice(): Promise<void> {
        if (!this.state.available || this.state.voice !== "off") return;
        if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
            this.set({ notice: "Voice requires a supported browser and HTTPS or localhost." });
            return;
        }
        const ticket = ++this.epoch;
        this.set({ voice: "joining", notice: "" });
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true }, video: false,
            });
        } catch {
            if (ticket === this.epoch) this.set({ voice: "off", notice: "Microphone access was denied or the device is unavailable." });
            return;
        }
        if (ticket !== this.epoch) {
            for (const track of stream.getTracks()) track.stop();
            return;
        }
        this.stream = stream;
        for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => {
            if (ticket !== this.epoch) return;
            this.leaveVoice();
            this.set({ notice: "The microphone disconnected." });
        }, { once: true });
        this.lastRetry = -Infinity;
        this.beginMembership(false);
    }

    leaveVoice(): void {
        if (this.stream && this.state.available) this.send({ kind: "voiceLeave" });
        this.stopVoice();
        this.set({ voice: "off", muted: false, ...NO_PEERS });
    }

    reset = (): void => {
        this.stopVoice();
        this.previousSelf = null;
        this.set(START);
    };

    toggleMute(): void {
        if (!this.stream) return;
        this.set({ muted: !this.state.muted });
        this.updateMicrophone();
    }

    resumePlayback(): void {
        for (const [id, peer] of this.connections) this.play(id, peer);
    }

    private updateMicrophone(): void {
        const enabled = this.state.available && this.self !== null && !this.state.muted;
        for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = enabled;
    }

    private stopVoice(): void {
        ++this.epoch;
        clearTimeout(this.relayDeadline);
        this.clearMembership();
        for (const track of this.stream?.getTracks() ?? []) track.stop();
        this.stream = undefined;
    }

    private clearMembership(): void {
        clearInterval(this.heartbeat);
        if (this.self) this.previousSelf = this.self;
        this.self = null;
        this.ice = undefined;
        this.updateMicrophone();
        for (const id of this.connections.keys()) this.closePeer(id);
    }

    private suspend(): void {
        if (this.stream) {
            this.clearMembership();
            this.relayDeadline = setTimeout(() => {
                this.leaveVoice();
                this.set({ notice: "Lost the relay connection. Join voice again when it returns." });
            }, RELAY_RECONNECT_MS);
        } else {
            this.stopVoice(); // Cancel any permission prompt still in flight.
        }
        this.set({
            available: false, relayReconnecting: true, voice: this.stream ? "reconnecting" : "off",
            notice: "", ...NO_PEERS,
        });
    }

    private beginMembership(replace: boolean): void {
        this.clearMembership();
        if (replace) {
            this.set({ voice: "reconnecting", notice: "", ...NO_PEERS });
            // A fresh ID gives both sides a clean negotiation, including when the answerer retries.
            // The ordered relay processes the leave before the join.
            this.send({ kind: "voiceLeave" });
        }
        this.lastRoster = performance.now();
        this.heartbeat = setInterval(() => {
            if (performance.now() - this.lastRoster > ROSTER_TIMEOUT_MS) {
                this.recoverMembership("Lost the voice session. Join voice again to retry.");
                return;
            }
            this.send({ kind: "voiceJoin" });
            for (const [id, peer] of this.connections) this.readRoute(id, peer);
        }, HEARTBEAT_MS);
        this.send({ kind: "voiceJoin" });
    }

    private recoverMembership(notice: string): boolean {
        const now = performance.now();
        if (now - this.lastRetry >= MEMBERSHIP_RETRY_COOLDOWN_MS) {
            this.lastRetry = now;
            this.beginMembership(true);
            return true;
        }
        if ([...this.connections.values()].every(peer => peer.failed) || now - this.lastRoster > ROSTER_TIMEOUT_MS) {
            this.leaveVoice();
            this.set({ notice });
        }
        return false;
    }

    private activePeer(id: string, peer: Peer): boolean {
        return this.connections.get(id) === peer && !peer.failed;
    }

    private releasePeer(peer: Peer): void {
        clearTimeout(peer.deadline);
        peer.pc.onicecandidate = null;
        peer.pc.onconnectionstatechange = null;
        peer.pc.oniceconnectionstatechange = null;
        peer.pc.ontrack = null;
        peer.pc.close();
        if (peer.audio) {
            peer.audio.pause();
            peer.audio.srcObject = null;
            peer.audio = undefined;
        }
        peer.local.length = 0;
        peer.remote.length = 0;
        peer.playbackBlocked = false;
    }

    private closePeer(id: string): void {
        const peer = this.connections.get(id);
        if (!peer) return;
        this.connections.delete(id);
        this.releasePeer(peer);
    }

    private iceServers(): RTCIceServer[] {
        const servers: RTCIceServer[] = stunUrl ? [{ urls: stunUrl }] : [];
        if (this.ice) {
            const { urls, username, credential } = this.ice;
            servers.push({ urls: [...urls], username, credential });
        }
        return servers;
    }

    private updateIce(ice?: RoomIceCredentials): void {
        if (this.ice?.expiresAt === ice?.expiresAt && this.ice?.username === ice?.username
            && this.ice?.credential === ice?.credential && this.ice?.urls.join(" ") === ice?.urls.join(" ")) return;
        this.ice = ice;
        for (const peer of this.connections.values()) {
            if (peer.failed) continue;
            // Preserve a working ICE pair. A new peer or a fresh membership gathers with the
            // refreshed credentials when a connection needs to be established again.
            try { peer.pc.setConfiguration({ ...peer.pc.getConfiguration(), iceServers: this.iceServers() }); }
            catch { /* Some browsers reject reconfiguration. New peer connections still get the new credentials. */ }
        }
    }

    private roster(self: string, ids: string[], ice?: RoomIceCredentials): void {
        if (self === this.previousSelf) return;
        this.lastRoster = performance.now();
        if (this.self !== self) {
            if (this.self) this.previousSelf = this.self;
            for (const id of this.connections.keys()) this.closePeer(id);
            this.ice = undefined;
            this.self = self;
            this.updateMicrophone();
        }
        this.updateIce(ice);
        const peers = new Set(ids.filter(id => id !== self));
        for (const id of this.connections.keys()) if (!peers.has(id)) this.closePeer(id);
        for (const id of peers) {
            if (this.connections.has(id)) continue;
            try { this.openPeer(self, id); }
            catch {
                this.leaveVoice();
                this.set({ notice: "Could not start a voice connection." });
                return;
            }
        }
        this.set({ voice: "joined", peers: peers.size });
        this.updateConnections();
    }

    private updateConnections(): void {
        const peers = [...this.connections.values()];
        const live = peers.filter(peer => !peer.failed && connected(peer));
        this.set({
            connectedVoicePeers: live.length,
            directVoicePeers: live.filter(peer => peer.route === "direct").length,
            relayedVoicePeers: live.filter(peer => peer.route === "relay").length,
            failedVoicePeers: peers.filter(peer => peer.failed).length,
            playbackBlocked: live.some(peer => peer.playbackBlocked),
        });
    }

    private readRoute(id: string, peer: Peer): void {
        if (!this.activePeer(id, peer) || !connected(peer) || peer.readingRoute) return;
        peer.readingRoute = true;
        void peer.pc.getStats().then(stats => {
            if (!this.activePeer(id, peer) || !connected(peer)) return;
            const route = selectedVoiceRoute(stats);
            if (route !== peer.route) {
                peer.route = route;
                this.updateConnections();
            }
        }).catch(() => {
            // Route information is advisory and some browsers omit ICE statistics.
        }).finally(() => { peer.readingRoute = false; });
    }

    private failPeer(id: string, peer: Peer): void {
        if (!this.activePeer(id, peer)) return;
        peer.failed = true;
        this.releasePeer(peer);
        const notice = this.ice ? "Could not reconnect voice. Join voice again to retry."
            : "Could not connect voice. This network may require a TURN relay.";
        if (!this.recoverMembership(notice)) this.updateConnections();
    }

    private connectionChanged(id: string, peer: Peer): void {
        if (!this.activePeer(id, peer)) return;
        const { connectionState, iceConnectionState } = peer.pc;
        if (connectionState === "failed" || connectionState === "closed" || iceConnectionState === "failed") {
            this.failPeer(id, peer);
            return;
        }
        if (connected(peer)) {
            clearTimeout(peer.deadline);
            peer.deadline = undefined;
            this.readRoute(id, peer);
        } else {
            peer.route = undefined;
            peer.deadline ??= setTimeout(() => this.failPeer(id, peer), PEER_DISCONNECT_MS);
        }
        this.updateConnections();
    }

    private openPeer(self: string, id: string): void {
        const pc = new RTCPeerConnection({ iceServers: this.iceServers() });
        const peer: Peer = {
            pc, local: [], remote: [], published: false, sentCandidates: 0, receivedDescription: false,
            receivedCandidates: 0, tasks: Promise.resolve(), failed: false, playbackBlocked: false,
            playAttempt: 0, readingRoute: false,
        };
        this.connections.set(id, peer);
        for (const track of this.stream!.getAudioTracks()) pc.addTrack(track, this.stream!);
        peer.deadline = setTimeout(() => this.failPeer(id, peer), PEER_CONNECT_MS);
        pc.onicecandidate = event => {
            if (!event.candidate || !this.activePeer(id, peer) || peer.sentCandidates >= MAX_CANDIDATES) return;
            peer.sentCandidates++;
            const candidate = event.candidate.toJSON();
            if (peer.published) this.sendSignal(id, peer, { candidate });
            else peer.local.push(candidate);
        };
        pc.onconnectionstatechange = pc.oniceconnectionstatechange = () => this.connectionChanged(id, peer);
        pc.ontrack = event => {
            if (!this.activePeer(id, peer) || event.track.kind !== "audio") return;
            peer.audio ??= new Audio();
            peer.audio.srcObject = new MediaStream([event.track]);
            this.play(id, peer);
        };
        // Only one side offers, even if both peers join at the same time.
        if (self < id) this.queue(id, peer, () => this.publishDescription(id, peer, "offer"));
    }

    private play(id: string, peer: Peer): void {
        if (!peer.audio) return;
        const attempt = ++peer.playAttempt;
        const report = (blocked: boolean) => {
            if (!this.activePeer(id, peer) || attempt !== peer.playAttempt || blocked === peer.playbackBlocked) return;
            peer.playbackBlocked = blocked;
            this.updateConnections();
        };
        void peer.audio.play().then(() => report(false), error => report(error?.name === "NotAllowedError"));
    }

    private queue(id: string, peer: Peer, task: () => Promise<void>): void {
        peer.tasks = peer.tasks.then(async () => {
            if (this.activePeer(id, peer)) await task();
        }).catch(() => this.failPeer(id, peer));
    }

    private sendSignal(id: string, peer: Peer, signal: Signal): boolean {
        if (!this.activePeer(id, peer)) return false;
        const request = readRoomCommsRequest({ kind: "signal", to: id, payload: JSON.stringify(signal) });
        if (!request) return false;
        this.send(request);
        return true;
    }

    private async publishDescription(id: string, peer: Peer, type: "offer" | "answer"): Promise<void> {
        const description = type === "offer" ? await peer.pc.createOffer() : await peer.pc.createAnswer();
        if (!this.activePeer(id, peer)) return;
        await peer.pc.setLocalDescription(description);
        if (!this.activePeer(id, peer)) return;
        const sdp = peer.pc.localDescription?.sdp;
        if (!sdp || !this.sendSignal(id, peer, { description: { type, sdp } }))
            throw new Error("Voice description could not be sent");
        peer.published = true;
        for (const candidate of peer.local.splice(0)) this.sendSignal(id, peer, { candidate });
    }

    private async addCandidates(id: string, peer: Peer): Promise<void> {
        for (const candidate of peer.remote.splice(0)) {
            if (!this.activePeer(id, peer)) return;
            await peer.pc.addIceCandidate(candidate).catch(() => {});
        }
    }

    private signal(id: string, payload: string): void {
        const peer = this.connections.get(id);
        if (!this.self || !peer || peer.failed) return;
        const signal = parseSignal(payload);
        if (!signal) return;
        // Cap the total number of admitted negotiation operations per pair of voice IDs.
        if ("description" in signal) {
            if (signal.description.type !== (this.self < id ? "answer" : "offer") || peer.receivedDescription) return;
            peer.receivedDescription = true;
            this.queue(id, peer, async () => {
                await peer.pc.setRemoteDescription(signal.description);
                await this.addCandidates(id, peer);
                if (this.activePeer(id, peer) && signal.description.type === "offer")
                    await this.publishDescription(id, peer, "answer");
            });
        } else if (peer.receivedCandidates < MAX_CANDIDATES) {
            peer.receivedCandidates++;
            peer.remote.push(signal.candidate);
            if (peer.pc.remoteDescription) this.queue(id, peer, () => this.addCandidates(id, peer));
        }
    }
}
