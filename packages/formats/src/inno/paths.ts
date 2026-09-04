export interface NormalizeInnoDestinationOptions {
    /** GOG Galaxy reassembly yields bare relative paths (e.g. SS2.exe, Data\foo). */
    allowBareRelative?: boolean;
}

interface InnoText {
    /** The destination with brace escapes expanded and constants removed. */
    literal: string;
    /** The constant at position 0, lowercased (e.g. "{app}"), or null. */
    leading: string | null;
    /** Constants found anywhere after position 0. */
    constants: number;
}

/**
 * Split an Inno destination into its literal text and its constants.
 *
 * A literal brace is written doubled (`{{` for `{`; GOG's builder doubles the closing one
 * too), while a single `{…}` is a constant like `{app}` or `{tmp}`. Telling them apart is
 * load-bearing: treating a doubled brace as an unresolvable constant silently drops real
 * files — Worms Armageddon's 12 stock schemes are stored as `User\Schemes\{{01}} …` and
 * were lost that way, with no error anywhere.
 */
function scanInnoText(dest: string): InnoText {
    let literal = "";
    let leading: string | null = null;
    let constants = 0;

    for (let i = 0; i < dest.length;) {
        const c = dest[i];
        const next = dest[i + 1];
        if ((c === "{" && next === "{") || (c === "}" && next === "}")) {
            literal += c;
            i += 2;
            continue;
        }
        if (c === "{") {
            const end = dest.indexOf("}", i + 1);
            const token = end < 0 ? dest.slice(i) : dest.slice(i, end + 1);
            if (i === 0) leading = token.toLowerCase();
            else constants++;
            i = end < 0 ? dest.length : end + 1;
            continue;
        }
        literal += c;
        i++;
    }

    return { literal, leading, constants };
}

function normalizeSafeRelativePath(path: string): string | null {
    const normalized = path.replace(/\//g, "\\");
    if (!normalized || normalized.startsWith("\\") || /^[a-z]:\\/i.test(normalized)) return null;

    const parts = normalized.split("\\");
    if (parts.length === 0) return null;
    for (const part of parts) {
        if (!part || part === "." || part === "..") return null;
    }
    return parts.join("/");
}

/**
 * GOG stages part of the real install under `__support\app\…`, which its installer copies
 * over the app directory. Those are the GAME's files, not installer scaffolding: Far Cry
 * keeps `Profiles\defaults\<lang>\game.cfg` — the bindings "Restore Defaults" reloads —
 * there, so dropping the tree with the rest of `__support` left the game nothing to restore
 * and blanked every control. The prefix names the destination on its own, so it resolves
 * ahead of the leading-constant rules; most such entries carry no `{app}` at all.
 */
const GOG_SUPPORT_APP = /^__support[\\/]app[\\/]/i;

export function normalizeInnoDestination(
    dest: string,
    opts: NormalizeInnoDestinationOptions = {},
): string | null {
    if (!dest) return null;
    const { literal, leading, constants } = scanInnoText(dest.replace(/\//g, "\\"));
    const rel = literal.startsWith("\\") ? literal.slice(1) : literal;

    if (constants === 0 && (leading === null || leading === "{app}") && GOG_SUPPORT_APP.test(rel)) {
        return normalizeSafeRelativePath(rel.replace(GOG_SUPPORT_APP, ""));
    }

    if (leading === "{app}") {
        // A second constant inside the path ({app}\{sys}\x) is not something we can resolve.
        if (constants > 0) return null;
        return normalizeSafeRelativePath(rel);
    }

    // {tmp}, {sys}, {group}, … — installer-runtime destinations, and any constant we don't
    // resolve. Not part of the installed game.
    if (leading !== null || constants > 0) return null;
    if (!opts.allowBareRelative) return null;
    return normalizeSafeRelativePath(literal);
}
