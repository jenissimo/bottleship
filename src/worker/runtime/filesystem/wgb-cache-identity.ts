export const WGB_CACHE_DIR = "wgb-cache";

export function shortHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, "0");
}

export function urlToCacheKey(url: string): string {
    const [path, query] = url.split("?");
    const base = path.split("/").pop() || "game";
    if (base.toLowerCase().endsWith(".wgb")) return base;
    return `${query ? `${base}-${shortHash(query)}` : base}.wgb`;
}

export interface WgbVersion { url: string; size: number; etag: string }

export function sameWgbVersion(a: WgbVersion, b: WgbVersion): boolean {
    return a.url === b.url && a.size === b.size && a.etag === b.etag;
}
