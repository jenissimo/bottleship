import React from "react";
import { Button, Hint, SettingsRow, SettingsSection } from "../ui";
import { normalizeNetworkConfig, networkInviteUrl } from "../network-config";
import type { SettingsDrawerProps } from "./types";

export default function SettingsNetworkSection({
  network, networkStatus, onNetworkChange,
}: SettingsDrawerProps): React.ReactElement {
  const [serverUrl, setServerUrl] = React.useState(network?.serverUrl ?? "");
  const [room, setRoom] = React.useState(network?.room ?? "");
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    setServerUrl(network?.serverUrl ?? "");
    setRoom(network?.room ?? "");
  }, [network]);
  const connect = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const config = normalizeNetworkConfig({ serverUrl, room, directPlay8: network?.directPlay8, winsock: network?.winsock });
      if (config && window.location.protocol === "https:" && new URL(config.serverUrl).protocol !== "https:") {
        throw new Error("Use an HTTPS LAN server from this page.");
      }
      onNetworkChange(config);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const status = networkStatus.state === "connected"
    ? `Connected · ${networkStatus.address ?? network?.room ?? ""}`
    : networkStatus.state === "connecting" ? "Connecting…"
    : networkStatus.state === "offline" ? "Offline" : networkStatus.reason ?? "Disconnected";
  const share = () => {
    if (!network) return;
    const url = networkInviteUrl(window.location.href, network);
    if (!navigator.clipboard) { setError("Copy this page URL to invite friends."); return; }
    void navigator.clipboard.writeText(url).then(
      () => setError("Invite link copied."),
      () => setError("Could not copy the invite link."),
    );
  };
  return (
    <SettingsSection>
      <Hint>Join the same room as your friends, then choose LAN multiplayer in the game.</Hint>
      <form onSubmit={connect}>
        <SettingsRow title="LAN server">
          <input aria-label="LAN server" type="url" required placeholder="https://lan.example.org"
            value={serverUrl} onChange={event => setServerUrl(event.target.value)}
            style={{ width: 260, maxWidth: "100%", padding: 8 }} />
        </SettingsRow>
        <SettingsRow title="Room">
          <input aria-label="Room" required maxLength={64} pattern="[A-Za-z0-9_-]+"
            value={room} onChange={event => setRoom(event.target.value)}
            style={{ width: 260, maxWidth: "100%", padding: 8 }} />
        </SettingsRow>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <Button type="submit" disabled={networkStatus.state === "connecting"}>Connect</Button>
          <Button type="button" disabled={!network} onClick={() => { onNetworkChange(null); setError(""); }}>Disconnect</Button>
          <Button type="button" disabled={networkStatus.state !== "connected"} onClick={share}>Copy invite link</Button>
        </div>
      </form>
      <p role="status">{status}</p>
      {error && <p role="status">{error}</p>}
    </SettingsSection>
  );
}
