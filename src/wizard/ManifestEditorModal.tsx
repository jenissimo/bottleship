import React, { useEffect, useState } from "react";
import { getEffectiveManifest, saveOverride, type ManifestOverride } from "../wgb-library";
import { cx } from "../ui/cx";
import s from "./ManifestEditorModal.module.css";
import ms from "../ui/Modal/Modal.module.css";
import { ActionButton } from "../ui/ActionButton";

interface ManifestEditorModalProps {
  gameKey: string | null;
  onClose: () => void;
  onSaved: () => void;
}

const OS_PRESETS: Array<{ id: string; label: string; v?: { major: number; minor: number; platformId: number } }> = [
  { id: "", label: "(unchanged)" },
  { id: "win95", label: "Windows 95", v: { major: 4, minor: 0, platformId: 1 } },
  { id: "win98", label: "Windows 98", v: { major: 4, minor: 10, platformId: 1 } },
  { id: "winnt4", label: "Windows NT 4.0", v: { major: 4, minor: 0, platformId: 2 } },
  { id: "win2k", label: "Windows 2000", v: { major: 5, minor: 0, platformId: 2 } },
  { id: "winxp", label: "Windows XP", v: { major: 5, minor: 1, platformId: 2 } },
];

function detectOsPreset(os: any): string {
  if (!os) return "";
  const m = OS_PRESETS.find((p) => p.v && p.v.major === os.major && p.v.minor === os.minor && p.v.platformId === (os.platformId ?? p.v.platformId));
  return m?.id ?? "";
}

// Touch-control presets (src/input/controls/presets.ts). "" = let the host auto-detect
// from what the game does — the right answer for almost every title.
const TOUCH_PRESETS: Array<{ id: string; label: string }> = [
  { id: "", label: "(auto-detect)" },
  { id: "pointer", label: "Pointer (tap to click)" },
  { id: "pointer-rmb", label: "Pointer + right-click / wheel" },
  { id: "wasd-look", label: "WASD + look pad" },
  { id: "dpad-buttons", label: "D-pad + buttons" },
  { id: "pad", label: "Gamepad" },
];

interface FormState {
  name: string;
  entrypoint: string;
  args: string;
  ramMB: string;
  resW: string;
  resH: string;
  resBpp: string;
  os: string;
  cdPath: string;
  skipVideo: boolean;
  touchLayout: string;
}

const EMPTY: FormState = { name: "", entrypoint: "", args: "", ramMB: "", resW: "", resH: "", resBpp: "", os: "", cdPath: "", skipVideo: false, touchLayout: "" };

export default function ManifestEditorModal({ gameKey, onClose, onSaved }: ManifestEditorModalProps) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!gameKey) return;
    setLoading(true);
    setError("");
    getEffectiveManifest(gameKey)
      .then((m) => {
        const e = m.emulator ?? {};
        const res = e.screenResolution ?? {};
        setForm({
          name: m.name ?? "",
          entrypoint: m.entrypoint ?? "",
          args: m.args ?? "",
          ramMB: e.memory?.ram ? String(Math.round(e.memory.ram / (1024 * 1024))) : "",
          resW: res.width ? String(res.width) : "",
          resH: res.height ? String(res.height) : "",
          resBpp: res.bpp ? String(res.bpp) : "",
          os: detectOsPreset(e.osVersion),
          cdPath: e.cdPath ?? "",
          skipVideo: !!e.skipVideo,
          // Only a preset id is editable here; an authored ControlLayout object is left
          // untouched by the select (the layout editor owns that form).
          touchLayout: typeof e.touch?.layout === "string" ? e.touch.layout : "",
        });
      })
      .catch((err) => setError(`Failed to read manifest: ${err?.message ?? err}`))
      .finally(() => setLoading(false));
  }, [gameKey]);

  if (!gameKey) return null;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const buildPatch = (): ManifestOverride => {
    const emulator: Record<string, unknown> = {};
    if (form.ramMB.trim()) emulator.memory = { ram: Math.round(Number(form.ramMB) * 1024 * 1024) };
    if (form.resW.trim() && form.resH.trim()) {
      emulator.screenResolution = {
        width: Number(form.resW),
        height: Number(form.resH),
        ...(form.resBpp.trim() ? { bpp: Number(form.resBpp) } : {}),
      };
    }
    const preset = OS_PRESETS.find((p) => p.id === form.os);
    if (preset?.v) emulator.osVersion = preset.v;
    if (form.cdPath.trim()) emulator.cdPath = form.cdPath.trim();
    emulator.skipVideo = form.skipVideo;
    if (form.touchLayout) emulator.touch = { layout: form.touchLayout };

    const patch: ManifestOverride = { emulator };
    if (form.name.trim()) patch.name = form.name.trim();
    if (form.entrypoint.trim()) patch.entrypoint = form.entrypoint.trim();
    patch.args = form.args;
    return patch;
  };

  const handleSave = async () => {
    if (!gameKey) return;
    setBusy(true);
    setError("");
    try {
      await saveOverride(gameKey, buildPatch());
      onSaved();
      onClose();
    } catch (err: any) {
      setError(`Failed to save: ${err?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (!gameKey || !confirm("Discard your edits and revert to the bundle's own manifest?")) return;
    setBusy(true);
    setError("");
    try {
      await saveOverride(gameKey, null);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(`Failed to reset: ${err?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={ms["modal-overlay"]} onClick={onClose}>
      <div
        className={cx(ms, "modal-content") + " " + s["medit-modal"]}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={ms["modal-header"]}>
          <h2>Edit manifest</h2>
          <button className={ms["modal-close"]} onClick={onClose}>×</button>
        </div>

        <div className={ms["modal-body"]}>
          <p className={s["addgame__intro"]}>
            // a non-destructive override layered on the bundle at load — the .wgb file is never rewritten.
          </p>
          {error && <div className={s["error"]}>{error}</div>}

          {loading ? (
            <div className={s["loading"]}>Reading manifest…</div>
          ) : (
            <div className={s["medit-grid"]}>
              <label className={s["medit-row"]}>
                <span className={s["medit-label"]}>Name</span>
                <input className={s["addgame__field"]} value={form.name} onChange={(e) => set("name", e.target.value)} />
              </label>
              <label className={s["medit-row"]}>
                <span className={s["medit-label"]}>Entrypoint (.exe)</span>
                <input className={s["addgame__field"]} value={form.entrypoint} spellCheck={false} onChange={(e) => set("entrypoint", e.target.value)} />
              </label>
              <label className={s["medit-row"]}>
                <span className={s["medit-label"]}>Arguments</span>
                <input className={s["addgame__field"]} value={form.args} spellCheck={false} onChange={(e) => set("args", e.target.value)} />
              </label>
              <label className={s["medit-row"]}>
                <span className={s["medit-label"]}>Windows version</span>
                <select className={s["addgame__field"]} value={form.os} onChange={(e) => set("os", e.target.value)}>
                  {OS_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </label>
              <label className={s["medit-row"]}>
                <span className={s["medit-label"]}>RAM (MB)</span>
                <input className={s["addgame__field"]} type="number" min={1} value={form.ramMB} placeholder="default" onChange={(e) => set("ramMB", e.target.value)} />
              </label>
              <div className={s["medit-row"]}>
                <span className={s["medit-label"]}>Resolution</span>
                <div className={s["medit-res"]}>
                  <input className={s["addgame__field"]} type="number" placeholder="W" value={form.resW} onChange={(e) => set("resW", e.target.value)} />
                  <span className={s["medit-x"]}>×</span>
                  <input className={s["addgame__field"]} type="number" placeholder="H" value={form.resH} onChange={(e) => set("resH", e.target.value)} />
                  <input className={s["addgame__field"]} type="number" placeholder="bpp" value={form.resBpp} onChange={(e) => set("resBpp", e.target.value)} />
                </div>
              </div>
              <label className={s["medit-row"]}>
                <span className={s["medit-label"]}>CD redirect (D:)</span>
                <input className={s["addgame__field"]} value={form.cdPath} spellCheck={false} placeholder="e.g. C:\Game\CD1" onChange={(e) => set("cdPath", e.target.value)} />
              </label>
              <label className={s["medit-row"]}>
                <span className={s["medit-label"]}>Touch controls</span>
                <select className={s["addgame__field"]} value={form.touchLayout} onChange={(e) => set("touchLayout", e.target.value)}>
                  {TOUCH_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </label>
              <label className={cx(s, "medit-row", "medit-row--check")}>
                <span className={s["medit-label"]}>Skip intro video</span>
                <input type="checkbox" checked={form.skipVideo} onChange={(e) => set("skipVideo", e.target.checked)} />
              </label>
            </div>
          )}

          <div className={s["medit-actions"]}>
            <ActionButton variant="secondary" onClick={handleReset} disabled={busy || loading}>
              Reset to bundle
            </ActionButton>
            <div className={s["medit-actions__right"]}>
              <span className={s["medit-hint"]}>applies on next launch</span>
              <ActionButton variant="primary" onClick={handleSave} disabled={busy || loading}>
                {busy ? "Saving…" : "Save"}
              </ActionButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
