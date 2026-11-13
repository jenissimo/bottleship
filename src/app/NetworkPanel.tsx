import React from "react";
import ms from "../ui/Modal/Modal.module.css";
import s from "./NetworkPanel.module.css";
import { ActionButton } from "../ui/ActionButton";
import {
  buildFriendLink, generateRoomName, normalizeNetworkConfig, parseRoomInput,
  type NetworkConfig, type NetworkStatus, type NetworkSuggestion, type ShareableGame,
} from "../network-config";

export const RUN_YOUR_OWN_SERVER_URL = "https://github.com/jenissimo/bottleship/blob/main/docs/multiplayer.md#run-your-own-server";

export interface NetworkPanelProps {
  /** "request": the game is waiting for an answer. "panel": opened from the toolbar. */
  mode: "request" | "panel";
  suggestion: NetworkSuggestion;
  /** The room this tab is in (or trying to join), if any. */
  network: NetworkConfig | null;
  status: NetworkStatus;
  game: ShareableGame;
  /** Remember is per game; without a game key there is nothing to remember it for. */
  canRemember: boolean;
  onConnect(config: NetworkConfig, remember: boolean): void;
  onNotNow(remember: boolean): void;
  onDisconnect(): void;
  onClose(): void;
}

type Choice = "create" | "join";

function copy(text: string, done: (message: string) => void): void {
  if (!navigator.clipboard) { done("Copy this link: " + text); return; }
  void navigator.clipboard.writeText(text).then(() => done("Link copied."), () => done("Could not copy. The link: " + text));
}

export default function NetworkPanel(props: NetworkPanelProps): React.ReactElement {
  const { mode, suggestion, network, status, game, canRemember } = props;
  const connected = status.state === "connected" && !!network;
  const connecting = status.state === "connecting";
  const [choice, setChoice] = React.useState<Choice>(suggestion.fromLink && suggestion.room ? "join" : "create");
  const [createdRoom, setCreatedRoom] = React.useState(() => generateRoomName());
  const [joinText, setJoinText] = React.useState(suggestion.fromLink ? suggestion.room : "");
  const [serverUrl, setServerUrl] = React.useState(suggestion.serverUrl);
  const [advancedOpen, setAdvancedOpen] = React.useState(!suggestion.serverUrl);
  const [remember, setRemember] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [inputError, setInputError] = React.useState("");

  // The room the primary button would join, and the server it would use.
  const target = React.useMemo((): { config: NetworkConfig | null; error: string } => {
    try {
      let room = createdRoom, server = serverUrl, invite: string | undefined;
      if (choice === "join") {
        if (!joinText.trim()) return { config: null, error: "" };
        const parsed = parseRoomInput(joinText);
        room = parsed.room; server = parsed.serverUrl ?? server; invite = parsed.invite ?? (parsed.room === suggestion.room ? suggestion.invite : undefined);
      }
      if (!server.trim()) return { config: null, error: "Enter a LAN server address." };
      const config = normalizeNetworkConfig({ serverUrl: server, room, ...(invite ? { invite } : {}) });
      if (config && window.location.protocol === "https:" && new URL(config.serverUrl).protocol !== "https:")
        return { config: null, error: "This page can only use an HTTPS LAN server." };
      return { config, error: "" };
    } catch (cause) { return { config: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [choice, createdRoom, joinText, serverUrl, suggestion.room, suggestion.invite]);

  const linkFor = (config: NetworkConfig) => buildFriendLink(window.location.origin, config, game);
  const shared = connected ? linkFor(network!) : target.config ? linkFor(target.config) : null;
  const connect = () => {
    if (!target.config) { setInputError(target.error || "Paste the link your friend sent, or a room name."); return; }
    setInputError(""); props.onConnect(target.config, remember);
  };
  const failed = status.state === "error" || status.state === "disconnected" ? status.reason ?? "Could not connect." : "";
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); if (mode === "request") props.onNotNow(false); else props.onClose(); }
  };
  const title = connected ? `Room ${network!.room}` : mode === "request" ? "Play over the network?" : "Network";

  return (
    <div className={ms["modal-overlay"]} onKeyDown={onKeyDown}>
      <div className={`${ms["modal-content"]} ${s.panel}`} role="dialog" aria-modal aria-label={title} tabIndex={-1}
        ref={el => { if (el && !el.contains(document.activeElement)) el.focus(); }} onClick={e => e.stopPropagation()}>
        <div className={ms["modal-header"]}>
          <h2>{title}</h2>
          {mode === "panel" && <button className={ms["modal-close"]} aria-label="Close" onClick={props.onClose}>×</button>}
        </div>
        <div className={s.body}>
          {connected ? (
            <>
              <p className={s.lead}>Connected to <span className={s.mono}>{new URL(network!.serverUrl).host}</span>. Your address on the virtual LAN is <span className={s.mono}>{status.address ?? "…"}</span>.</p>
              <p className={s.hint}>Ask your friend to join room <span className={s.mono}>{network!.room}</span>, then choose LAN multiplayer in the game.</p>
              {shared && !shared.includesGame && <p className={s.note}>Your friend needs their own copy of this game: the link opens the room, not the game.</p>}
            </>
          ) : (
            <>
              {mode === "request" && <p className={s.lead}>This game wants to play over the network. BottleShip connects to a relay server only after you choose a room.</p>}
              <div className={s.choices} role="radiogroup" aria-label="Room">
                <button type="button" role="radio" aria-checked={choice === "create"} className={`${s.choice} ${choice === "create" ? s.selected : ""}`} onClick={() => setChoice("create")}>
                  <span className={s["choice-title"]}>Create room</span>
                  <span className={s["choice-text"]}>Host, then send the link.</span>
                </button>
                <button type="button" role="radio" aria-checked={choice === "join"} className={`${s.choice} ${choice === "join" ? s.selected : ""}`} onClick={() => setChoice("join")}>
                  <span className={s["choice-title"]}>Join room</span>
                  <span className={s["choice-text"]}>Use a friend's link or room name.</span>
                </button>
              </div>
              {choice === "create" ? (
                <div className={s.field}>
                  <label className={s.label} htmlFor="bs-net-room">Room name</label>
                  <div className={s.row}>
                    <input id="bs-net-room" className={`${s.input} ${s.mono}`} value={createdRoom} maxLength={64}
                      onChange={e => setCreatedRoom(e.target.value.trim())} />
                    <ActionButton type="button" onClick={() => setCreatedRoom(generateRoomName())} title="Another name">New name</ActionButton>
                  </div>
                  <div className={s.row}>
                    <ActionButton type="button" disabled={!shared} onClick={() => shared && copy(shared.url, setNotice)}>Copy link for a friend</ActionButton>
                  </div>
                  {shared && !shared.includesGame && <p className={s.note}>Your friend needs their own copy of this game: the link opens the room, not the game.</p>}
                </div>
              ) : (
                <div className={s.field}>
                  <label className={s.label} htmlFor="bs-net-join">Link or room name</label>
                  <input id="bs-net-join" className={s.input} value={joinText} placeholder="quiet-otter-4821" autoFocus={!suggestion.fromLink}
                    onChange={e => setJoinText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") connect(); }} />
                </div>
              )}
              <p className={s.hint}>Rooms are public: anyone who knows the room name can join it.</p>
              <details className={s.advanced} open={advancedOpen} onToggle={e => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
                <summary>Advanced</summary>
                <div className={s.field}>
                  <label className={s.label} htmlFor="bs-net-server">LAN server</label>
                  <input id="bs-net-server" className={`${s.input} ${s.mono}`} type="url" value={serverUrl} placeholder="https://lan.example.org"
                    onChange={e => setServerUrl(e.target.value)} />
                  {!suggestion.serverUrl && <p className={s.hint}>This site has no default server. <a href={RUN_YOUR_OWN_SERVER_URL} target="_blank" rel="noopener noreferrer">Run your own server</a>.</p>}
                </div>
              </details>
              {canRemember && (
                <label className={s.check}>
                  <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                  Remember for this game
                </label>
              )}
            </>
          )}
          {(() => {
            const error = !connecting && (inputError || (!connected && failed));
            if (!connecting && !error && !notice) return null;
            return (
              <div className={s.status} data-tone={error ? "error" : "info"} role="status" aria-live="polite">
                {connecting ? "Connecting…" : error ? <>{error}{/own server/i.test(String(error)) && <> <a href={RUN_YOUR_OWN_SERVER_URL} target="_blank" rel="noopener noreferrer">How to run one</a></>}</> : notice}
              </div>
            );
          })()}
        </div>
        <div className={s.footer}>
          {connected ? (
            <>
              <ActionButton type="button" onClick={props.onDisconnect}>Disconnect</ActionButton>
              <span className={s.spacer} />
              {shared && <ActionButton type="button" onClick={() => copy(shared.url, setNotice)}>Copy link for a friend</ActionButton>}
              <ActionButton type="button" variant="primary" autoFocus onClick={props.onClose}>Done</ActionButton>
            </>
          ) : (
            <>
              <ActionButton type="button" onClick={() => mode === "request" ? props.onNotNow(remember) : props.onClose()}>
                {mode === "request" ? "Not now" : "Cancel"}
              </ActionButton>
              <span className={s.spacer} />
              <ActionButton type="button" variant="primary" disabled={connecting || (choice === "join" && !joinText.trim())} autoFocus={suggestion.fromLink} onClick={connect}>
                {choice === "create" ? "Create room" : target.config ? `Join ${target.config.room}` : "Join room"}
              </ActionButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Toolbar status: what the network is doing right now; a click opens the panel. */
export function NetworkIndicator({ status, network, onClick, className }: {
  status: NetworkStatus; network: NetworkConfig | null; onClick: () => void; className?: string;
}): React.ReactElement {
  const state = status.state === "connected" && network ? "online" : status.state === "connecting" ? "connecting" : status.state === "error" ? "error" : "offline";
  const label = state === "online" ? `Room ${network!.room}` : state === "connecting" ? "Connecting…" : state === "error" ? "Network error" : "Offline";
  return (
    <button type="button" className={`${className ?? ""} ${s.indicator}`} data-state={state} onClick={onClick}
      title={state === "online" ? `Connected to ${new URL(network!.serverUrl).host}` : "Network"}>
      <span className={s.dot} aria-hidden />
      <span className={s["indicator-label"]}>{label}</span>
    </button>
  );
}
