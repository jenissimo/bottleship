/**
 * Harness sessions — how several agents drive several tabs of ONE Chrome without
 * touching each other's.
 *
 * A session is a short name: `BS_TAB=alpha` on the CLI side, `?bs=alpha` on the page.
 * It does two things and nothing else: it selects/creates the tab, and it re-roots
 * every artifact the run produces under `logs/<name>/`. A screenshot, a journal and
 * an archived log line then always belong to the tab that produced them — an agent
 * reading another guest's evidence is the failure mode this exists to prevent.
 *
 * The empty name is the default single-tab session: no query param, artifacts at
 * their historical paths, tab selection as it always was. Everything here is pure
 * (no I/O, no globals) so both the browser bundle and the Bun tools can use it.
 */

export const SESSION_ENV = "BS_TAB";
export const SESSION_PARAM = "bs";

/** Names are also directory names and URL tokens — keep them boring. */
const VALID_NAME = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/** Lowercase + validate. Anything that isn't a legal name is "no session". */
export function normalizeSession(raw: string | null | undefined): string {
    const s = (raw ?? "").trim().toLowerCase();
    return VALID_NAME.test(s) ? s : "";
}

/** The session this PROCESS drives, from `BS_TAB`. Throws on a set-but-invalid value:
 *  silently falling back to the shared default tab is how two agents collide. */
export function sessionFromEnv(env: Record<string, string | undefined>): string {
    const raw = (env[SESSION_ENV] ?? "").trim();
    if (!raw) return "";
    const name = normalizeSession(raw);
    if (!name) {
        throw new Error(
            `invalid ${SESSION_ENV}='${raw}' — 1-24 chars of [a-z0-9_-], starting alphanumeric`,
        );
    }
    return name;
}

/** The session this PAGE belongs to, from its own `?bs=` query param. Never throws. */
export function sessionFromLocation(search: string): string {
    const m = /[?&]bs=([^&#]*)/.exec(search ?? "");
    return m ? normalizeSession(decodeURIComponent(m[1])) : "";
}

/** The query token that pins a tab to a session. */
export function sessionToken(name: string): string {
    return name ? `${SESSION_PARAM}=${name}` : "";
}

/** Add `?bs=<name>` to a dev URL (idempotent; a no-op for the default session). */
export function sessionUrl(baseUrl: string, name: string): string {
    if (!name || urlInSession(baseUrl, name)) return baseUrl;
    return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${sessionToken(name)}`;
}

/** Is `url` pinned to session `name`? A whole query token, so `alpha` never matches `alpha2`. */
export function urlInSession(url: string, name: string): boolean {
    if (!name) return true;
    return new RegExp(`[?&]${SESSION_PARAM}=${name}(?:[&#]|$)`).test(url);
}

/** Does the url carry ANY session marker? The default session claims unmarked tabs. */
export function urlHasSession(url: string): boolean {
    return new RegExp(`[?&]${SESSION_PARAM}=[a-z0-9][a-z0-9_-]*(?:[&#]|$)`).test(url);
}

/** Whose tab is this? Named sessions own their own token; the default owns the unmarked. */
export function sessionOwnsUrl(url: string, name: string): boolean {
    return name ? urlInSession(url, name) : !urlHasSession(url);
}

export interface TabLike { type: string; url: string }

/**
 * Pick the tab a session drives.
 *
 * Named: only a tab carrying its own token — never a sibling's.
 * Default (BS_TAB unset): an UNMARKED tab, and NOTHING else — never a named sibling's, not
 * even as a last resort. A marked tab belongs to some agent, and one dropped `BS_TAB=` prefix
 * would otherwise load a bundle into their live guest. No match returns undefined so the
 * caller fails loudly with the tab list, which names the mistake.
 */
export function pickSessionTab<T extends TabLike>(
    list: readonly T[],
    name: string,
    opts: { type: string; urlMatch: string },
): T | undefined {
    const cands = list.filter((t) => t.type === opts.type && t.url.includes(opts.urlMatch));
    return cands.find((t) => sessionOwnsUrl(t.url, name));
}

/** logs-relative path re-rooted into the session subtree: `debug/x.png` → `alpha/debug/x.png`. */
export function sessionRelPath(rel: string, name: string): string {
    const clean = rel.replace(/^[/\\]+/, "");
    return name ? `${name}/${clean}` : clean;
}

/** Repo-relative path of a logs-relative artifact: `debug/x.png` → `logs/alpha/debug/x.png`. */
export function sessionLogPath(rel: string, name: string): string {
    return `logs/${sessionRelPath(rel, name)}`;
}

/** Re-root an artifact path already written as `logs/…`. Paths outside `logs/` are
 *  returned untouched — an explicitly passed output file is the caller's choice. */
export function sessionArtifactPath(path: string, name: string): string {
    if (!name) return path;
    const m = /^(\.?\/)?logs[/\\]/.exec(path);
    if (!m) return path;
    return `${m[0]}${name}/${path.slice(m[0].length)}`;
}

/** Directory the log archive writes this session's stream into. */
export function sessionLogDir(root: string, name: string): string {
    return name ? `${root}/${name}` : root;
}
