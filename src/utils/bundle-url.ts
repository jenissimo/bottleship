import { SIDECAR_PORT } from "./log-client";

/**
 * Turning an absolute disk path into the URL the worker should stream from.
 *
 * Two dev servers can deliver a `.wgb` off disk, and the choice matters: a bundle read is
 * the hot path of every boot (8 MB ranges while the guest thread is parked on a 30 s
 * deadline), and Vite's throughput on `/__wgb/` decays over a long-lived dev server until
 * that deadline blows ("SabIoSource: read timed out"). So prefer the sidecar's `/wgb` and
 * fall back to Vite's route only when :3001 is not running.
 *
 * Shared by the harness facade and the dev bundle browser — one definition, so a bundle
 * opened by hand and the same bundle opened by a harness script take the same route.
 */

/** Probed once per page: the answer only changes when the dev stack is restarted, and a
 *  failed probe costs a round-trip on every load otherwise. */
let sidecarUp: boolean | null = null;

export async function sidecarAvailable(): Promise<boolean> {
    if (sidecarUp !== null) return sidecarUp;
    try {
        const r = await fetch(`http://localhost:${SIDECAR_PORT}/health`, { method: "GET" });
        sidecarUp = r.ok;
    } catch { sidecarUp = false; }
    return sidecarUp;
}

export interface DiskBundleUrl {
    url: string;
    /** Which server will serve the body — surfaced in the UI because the Vite fallback is
     *  the one that degrades, and a slow boot should name its own cause. */
    via: "sidecar" | "vite";
}

/**
 * The bundle's own name, for naming its log file. A disk-served bundle arrives as
 * `…/wgb?path=G%3A%5CWGB%5Ctodo%5Cbod.wgb` — the separators are percent-encoded, so
 * splitting the URL on `/` yields the whole query string and the archive fills with
 * files no one can tell apart. Read the `path=` param when there is one.
 */
export function bundleLogName(urlOrPath: string): string {
    let candidate = urlOrPath;
    const q = urlOrPath.indexOf("?");
    if (q >= 0) {
        const p = new URLSearchParams(urlOrPath.slice(q + 1)).get("path");
        if (p) candidate = p;
    }
    return candidate.split(/[\\/]/).pop()?.replace(/\.wgb$/i, "") || "game";
}

export async function diskBundleUrl(absPath: string): Promise<DiskBundleUrl> {
    const enc = encodeURIComponent(absPath);
    return (await sidecarAvailable())
        ? { url: `http://localhost:${SIDECAR_PORT}/wgb?path=${enc}`, via: "sidecar" }
        : { url: `/__wgb/?path=${enc}`, via: "vite" };
}
