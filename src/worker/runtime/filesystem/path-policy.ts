/**
 * Persist/ephemeral path policy (#12 — the ".gitignore" analog).
 *
 * Decides whether a guest-written file is PERSISTED (survives to the per-game OPFS container) or
 * EPHEMERAL (lives only in memory for the session, never written to OPFS, gone on next launch).
 *
 * Default is PERSIST: losing a save is unrecoverable, so everything the guest writes survives unless
 * it matches a global default or a per-game `emulator.ephemeral` glob. The `persistOnly` opt-in flips
 * to allowlist mode — only the global save defaults + `emulator.persist` globs persist, everything
 * else is ephemeral — for games that churn lots of junk around a known-small save set.
 *
 * Patterns are matched against the OVERLAY-RELATIVE posix path (drive stripped, lowercased, `\`→`/`),
 * gitignore-style: a pattern with no `/` matches the basename in any directory (`*.log`); a pattern
 * with `/` matches the full relative path. `**` matches across `/`, `*`/`?` do not.
 */

/**
 * Default globs treated as ephemeral when in persist-by-default mode.
 *
 * A directory named `cache` is deliberately NOT here. What an application caches on disk is
 * what it found expensive to compute — a shader cache, a converted asset, precomputed
 * lighting — and dropping it means paying that cost on every launch, or, when the thing that
 * built it cannot run again, never having it at all (CryEngine builds its shader cache by
 * spawning a compiler). These names are the ones whose CONTENT is disposable by convention:
 * logs, crash dumps, editor backups, and the temp directories the OS itself treats that way.
 */
export const DEFAULT_EPHEMERAL_GLOBS = [
    "*.log",
    "*.tmp",
    "*.temp",
    "*.dmp",
    "*.bak",
    "*.pyc",
    "temp/**",
    "tmp/**",
];

/** Default globs treated as persistent when in allowlist (persistOnly) mode. */
export const DEFAULT_PERSIST_GLOBS = [
    "*.sav",
    "*.save",
    "*.cfg",
    "*.ini",
    "*.dat",
];

export type Classification = "persist" | "ephemeral";

/** Convert a guest path (absolute `C:\Game\Foo.LOG`) to an overlay-relative posix key (`game/foo.log`). */
export function toOverlayRel(guestPath: string): string {
    let p = guestPath.trim().replace(/\\/g, "/").toLowerCase();
    // strip a leading drive ("c:/...") or leading slashes
    p = p.replace(/^[a-z]:\/?/, "").replace(/^\/+/, "");
    return p;
}

/**
 * Compile a glob into a regex with gitignore "match at any depth" semantics: a pattern with a leading
 * "/" is anchored to the overlay root; otherwise it matches at any directory level (so `*.log` and
 * `temp/**` match wherever they occur). `**` crosses `/`; `*`/`?` do not.
 */
function globToRegExp(glob: string): RegExp {
    const rooted = glob.startsWith("/");
    const body = rooted ? glob.slice(1) : glob;
    let re = "";
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === "*") {
            if (body[i + 1] === "*") { re += ".*"; i++; }   // ** → any incl /
            else re += "[^/]*";                              // *  → any excl /
        } else if (c === "?") {
            re += "[^/]";
        } else if ("\\^$.|+()[]{}".includes(c)) {
            re += "\\" + c;
        } else {
            re += c;
        }
    }
    // Non-rooted patterns may start at the root or after any "/" segment boundary.
    const prefix = rooted ? "^" : "(^|.*/)";
    return new RegExp(prefix + re + "$");
}

function compile(globs: string[]): RegExp[] {
    return globs.map((g) => globToRegExp(g.trim().replace(/\\/g, "/").toLowerCase()));
}

function matchesAny(rel: string, rules: RegExp[]): boolean {
    for (const r of rules) if (r.test(rel)) return true;
    return false;
}

export interface PathPolicyConfig {
    /** Additional per-game ephemeral globs (manifest.emulator.ephemeral). */
    ephemeral?: string[];
    /** Allowlist mode: only persist globs (+ defaults) survive. */
    persistOnly?: boolean;
    /** Per-game persist globs when persistOnly (manifest.emulator.persist). */
    persist?: string[];
}

export class PathPolicy {
    private readonly ephemeralRules: RegExp[];
    private readonly persistRules: RegExp[];
    private readonly persistOnly: boolean;

    constructor(cfg: PathPolicyConfig = {}) {
        this.persistOnly = !!cfg.persistOnly;
        this.ephemeralRules = compile([...DEFAULT_EPHEMERAL_GLOBS, ...(cfg.ephemeral ?? [])]);
        this.persistRules = compile([...DEFAULT_PERSIST_GLOBS, ...(cfg.persist ?? [])]);
    }

    classify(guestPath: string): Classification {
        const rel = toOverlayRel(guestPath);
        if (this.persistOnly) {
            // Allowlist: persist only known-save paths; everything else is ephemeral.
            return matchesAny(rel, this.persistRules) ? "persist" : "ephemeral";
        }
        // Default: persist everything except declared ephemeral.
        return matchesAny(rel, this.ephemeralRules) ? "ephemeral" : "persist";
    }

    isEphemeral(guestPath: string): boolean {
        return this.classify(guestPath) === "ephemeral";
    }
}

/** The neutral default policy (persist-by-default, only the global ephemeral defaults). */
export const DEFAULT_PATH_POLICY = new PathPolicy();
