import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Headphones, Microphone, MicrophoneSlash, PaperPlaneTilt, PhoneDisconnect } from "@phosphor-icons/react";
import { ActionButton } from "../ui/ActionButton";
import type { RoomCommsClient } from "./room-comms-client";
import s from "./RoomCommsPanel.module.css";

export default function RoomCommsPanel({ client }: { client: RoomCommsClient }) {
    const state = useSyncExternalStore(client.subscribe, client.snapshot);
    const [draft, setDraft] = useState("");
    const log = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (log.current) log.current.scrollTop = log.current.scrollHeight;
    }, [state.messages]);
    if (!state.available && !state.relayReconnecting) return null;

    let voiceStatus: string;
    if (state.voice === "off") voiceStatus = "Joining shares your microphone and network address with voice peers.";
    else if (state.voice === "joining") voiceStatus = "Joining voice…";
    else if (state.voice === "reconnecting") voiceStatus = "Reconnecting voice…";
    else if (state.peers === 0) voiceStatus = "In voice. Waiting for other players.";
    else {
        const paths = [];
        if (state.directVoicePeers) paths.push(`${state.directVoicePeers} direct`);
        if (state.relayedVoicePeers) paths.push(`${state.relayedVoicePeers} via TURN`);
        if (state.failedVoicePeers) paths.push(`${state.failedVoicePeers} failed`);
        const details = paths.length ? ` (${paths.join(", ")})` : "";
        voiceStatus = `${state.connectedVoicePeers} of ${state.peers} voice peers connected${details}.`;
    }

    return <section data-host-keys className={s.panel} aria-label="Room chat and voice">
        <h3>Room chat</h3>
        {state.relayReconnecting && <p className={s.hint} role="status">Reconnecting to the room…</p>}
        <div ref={log} className={s.messages} role="log" aria-label="Room messages" tabIndex={0}>
            {state.messages.length === 0 && <p className={s.hint}>Messages appear here while you are connected.</p>}
            {state.messages.map(line => <p key={line.id}><strong>{line.sender}</strong> {line.text}</p>)}
        </div>
        <form className={s.row} onSubmit={event => {
            event.preventDefault();
            if (client.chat(draft)) setDraft("");
        }}>
            <input className={s.input} aria-label="Message" placeholder="Message the room" maxLength={512}
                disabled={!state.available} value={draft} onChange={event => setDraft(event.target.value)} />
            <ActionButton type="submit" disabled={!state.available || !draft.trim()}><PaperPlaneTilt size={16} aria-hidden /> Send</ActionButton>
        </form>
        <h3>Voice</h3>
        <div className={s.row}>
            {state.voice === "off" ? <ActionButton type="button" disabled={!state.available} onClick={() => void client.joinVoice()}><Headphones size={16} aria-hidden /> Join voice</ActionButton> : <>
                <ActionButton type="button" onClick={() => client.leaveVoice()}><PhoneDisconnect size={16} aria-hidden /> Leave voice</ActionButton>
                <ActionButton type="button" disabled={state.voice === "joining"} aria-pressed={state.muted}
                    onClick={() => client.toggleMute()}>
                    {state.muted ? <><MicrophoneSlash size={16} aria-hidden /> Unmute microphone</> :
                        <><Microphone size={16} aria-hidden /> Mute microphone</>}
                </ActionButton>
            </>}
            {state.playbackBlocked && <ActionButton type="button" onClick={() => client.resumePlayback()}>Play voice audio</ActionButton>}
        </div>
        <p className={s.hint} role="status">{voiceStatus}</p>
        {state.notice && <p className={s.hint} role="status">{state.notice}</p>}
    </section>;
}
