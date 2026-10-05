import React from "react";
import { DownloadSimple, Trash, UploadSimple } from "@phosphor-icons/react";
import {
  type CachedBundleInfo,
  type GameStorageInfo,
  type StorageEstimate,
  evictCachedBundle,
  evictGameContainer,
  exportGameContainer,
  formatBytes,
  getCachedBundleFile,
  getStorageEstimate,
  importGameContainer,
  listCachedBundles,
  listGameStorage,
  requestPersistentStorage,
  temporaryImportBytes,
  clearTemporaryImports,
} from "../storage-manager";
import { downloadBlob, pickFile, SettingsIconBtn } from "../settings/SettingsIconBtn";
import { asBlobPart } from "../dom-buffer";
import s from "./StorageManagerBody.module.css";
import sh from "../ui/SectionHeading/SectionHeading.module.css";
import hm from "../ui/Hint/Hint.module.css";
import bm from "../ui/Button/Button.module.css";

export default function StorageManagerBody({ active }: { active: boolean }): React.ReactElement {
  const [estimate, setEstimate] = React.useState<StorageEstimate | null>(null);
  const [games, setGames] = React.useState<GameStorageInfo[]>([]);
  const [bundles, setBundles] = React.useState<CachedBundleInfo[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [temporaryBytes, setTemporaryBytes] = React.useState(0);
  const [storageError, setStorageError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    try {
      const [est, g, b, temporary] = await Promise.all([getStorageEstimate(), listGameStorage(), listCachedBundles(), temporaryImportBytes()]);
      setEstimate(est);
      setGames(g);
      setBundles(b);
      setTemporaryBytes(temporary);
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const usedPct =
    estimate && estimate.quotaBytes > 0 ? Math.min(100, (estimate.usageBytes / estimate.quotaBytes) * 100) : 0;

  return (
    <>
      <h3 className={sh["sect-h"]}>Browser storage</h3>
      {estimate ? (
        <div className={s["usage"]}>
          <div className={s["usage__bar"]}>
            <div className={s["usage__seg"]} style={{ width: `${usedPct}%`, background: usedPct > 90 ? "var(--coral)" : "var(--cyan)" }} />
          </div>
          <div className={s["usage__legend"]}>
            <span>
              <i style={{ background: "var(--cyan)" }} />
              {formatBytes(estimate.usageBytes)} used
            </span>
            <span style={{ marginLeft: "auto", color: "var(--fg-2)" }}>
              {formatBytes(estimate.usageBytes)} / {formatBytes(estimate.quotaBytes)} ·{" "}
              {estimate.persisted ? "persistent ✓" : "not persistent"}
            </span>
          </div>
          {!estimate.persisted && (
            <button
              className={bm["btn"]}
              style={{ marginTop: 10 }}
              onClick={async () => {
                await requestPersistentStorage();
                void refresh();
              }}
            >
              Make persistent
            </button>
          )}
        </div>
      ) : (
        <p className={hm["hint"]}>Reading storage usage…</p>
      )}

      <h3 className={sh["sect-h"]} style={{ marginTop: 8 }}>
        Per-game storage
      </h3>
      {games.length === 0 ? (
        <p className={hm["hint"]}>No game data yet.</p>
      ) : (
        <div className={s["glist"]}>
          {games.map((g) => (
            <div className={s["glist__row"]} key={g.containerDir}>
              <div>
                <div className={s["glist__name"]}>{g.containerDir}</div>
                <div className={s["glist__sub"]}>overlay + registry</div>
              </div>
              <span className={s["glist__sz"]}>{formatBytes(g.totalBytes)}</span>
              <div className={s["glist__actions"]}>
                <SettingsIconBtn
                  icon={DownloadSimple}
                  title="Download saves (.zip)"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const bytes = await exportGameContainer(g.containerDir);
                      if (!bytes) {
                        alert("Nothing to export yet — this game has no saved data.");
                        return;
                      }
                      downloadBlob(asBlobPart(bytes), `${g.containerDir}-saves.zip`, "application/zip");
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                <SettingsIconBtn
                  icon={UploadSimple}
                  title="Import saves (.zip)"
                  disabled={busy}
                  onClick={async () => {
                    const file = await pickFile(".zip");
                    if (!file) return;
                    if (!confirm(`Import saves into "${g.containerDir}"? Existing files with the same names are overwritten.`)) return;
                    setBusy(true);
                    try {
                      const n = await importGameContainer(g.containerDir, new Uint8Array(await file.arrayBuffer()));
                      alert(`Imported ${n} file${n === 1 ? "" : "s"}.`);
                      await refresh();
                    } catch (err) {
                      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                <SettingsIconBtn
                  icon={Trash}
                  title="Delete saves & settings"
                  danger
                  disabled={busy}
                  onClick={async () => {
                    if (!confirm(`Delete saves & settings for "${g.containerDir}"? This cannot be undone.`)) return;
                    await evictGameContainer(g.containerDir);
                    void refresh();
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 className={sh["sect-h"]} style={{ marginTop: 18 }}>
        Cached game files
      </h3>
      {bundles.length === 0 ? (
        <p className={hm["hint"]}>No cached bundles.</p>
      ) : (
        <div className={s["glist"]}>
          {bundles.map((b) => (
            <div className={s["glist__row"]} key={b.key}>
              <div>
                <div className={s["glist__name"]}>{b.key}</div>
                <div className={s["glist__sub"]}>ROM cache · re-downloadable</div>
              </div>
              <span className={s["glist__sz"]}>{formatBytes(b.bytes)}</span>
              <div className={s["glist__actions"]}>
                <SettingsIconBtn
                  icon={DownloadSimple}
                  title="Download .wgb bundle"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const file = await getCachedBundleFile(b.key);
                      if (!file) {
                        alert("Couldn't read this bundle (it may be in use).");
                        return;
                      }
                      downloadBlob(file, b.key, "application/octet-stream");
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                <SettingsIconBtn
                  icon={Trash}
                  title="Free cached files"
                  danger
                  disabled={busy}
                  onClick={async () => {
                    await evictCachedBundle(b.key);
                    void refresh();
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 className={sh["sect-h"]} style={{ marginTop: 18 }}>Temporary imports & exports</h3>
      <p className={hm["hint"]}>{formatBytes(temporaryBytes)} · unfinished imports and downloaded packages.</p>
      <button className={bm["btn"]} disabled={busy || temporaryBytes === 0} onClick={async () => {
        setBusy(true); setStorageError(null);
        try { await clearTemporaryImports(); await refresh(); }
        catch (err) { setStorageError(`Could not clear temporary files: ${err instanceof Error ? err.message : String(err)}`); }
        finally { setBusy(false); }
      }}>Free temporary files</button>
      {storageError && <p role="alert" className={hm["hint"]}>{storageError}</p>}

      <p className={hm["hint"]} style={{ marginTop: 12 }}>
        Saves persist by default; <code>*.log · temp/** · cache/**</code> stay ephemeral.{" "}
        <a style={{ color: "var(--cyan-soft)", cursor: "pointer" }} onClick={() => void refresh()}>
          {busy ? "Refreshing…" : "Refresh"}
        </a>
      </p>
    </>
  );
}
