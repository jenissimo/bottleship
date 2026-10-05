/**
 * Matching for the manifest's per-bundle DLL rule lists (`disabledDlls`, `appDirDlls`).
 *
 * A rule may be a bare name ("ddraw"), a filename ("ddraw.dll"), a path
 * ("drivers\\opengl3\\opengl3z.dll") or a wildcard of either. The request being tested is
 * whatever the guest passed to LoadLibrary/an import descriptor, so it may equally be a
 * bare name or a full path — hence both sides are reduced to the same candidate set
 * before comparing. One implementation, because two copies of this drift into two
 * different answers for the same rule.
 */

function wildcardToRegExp(pattern: string): RegExp {
    // `?` is deliberately NOT escaped here — it is a wildcard, rewritten to `.` below.
    // Escaping it first yields a literal `\.`, so "d3d?.dll" would match only "d3d..dll".
    const escaped = pattern.replace(/[-/\\^$+.()|[\]{}]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

export function normalizeDllPathToken(value: string): string {
    return value.trim().replace(/^"+|"+$/g, "").replace(/\//g, "\\");
}

export function stripDllExtension(value: string): string {
    return value.replace(/\.dll$/i, "");
}

/** The rule that matches `pathOrName`, or null. Returns the RAW rule so callers can log it. */
export function findDllRule(rules: readonly string[] | undefined, pathOrName: string): string | null {
    if (!rules?.length || !pathOrName) return null;

    const full = normalizeDllPathToken(pathOrName).toLowerCase();
    const fullNoDot = full.replace(/^[.\\]+/, "");
    const fullNoDrive = fullNoDot.replace(/^[a-z]:\\/, "");
    const base = full.split("\\").pop() ?? full;
    const baseNoExt = stripDllExtension(base);
    const candidates = Array.from(new Set([full, fullNoDot, fullNoDrive, base, baseNoExt]));

    for (const rawRule of rules) {
        const ruleToken = normalizeDllPathToken(rawRule);
        if (!ruleToken) continue;

        const rule = ruleToken.toLowerCase();
        const ruleNoDot = rule.replace(/^[.\\]+/, "");
        const ruleNoDrive = ruleNoDot.replace(/^[a-z]:\\/, "");
        const ruleBase = rule.split("\\").pop() ?? rule;
        const ruleBaseNoExt = stripDllExtension(ruleBase);

        if (/[*?]/.test(rule) || /[*?]/.test(ruleBase)) {
            const patterns = Array.from(new Set([rule, ruleNoDot, ruleNoDrive, ruleBase, ruleBaseNoExt]));
            for (const pattern of patterns) {
                if (!pattern) continue;
                const rx = wildcardToRegExp(pattern);
                if (candidates.some((c) => rx.test(c))) return rawRule;
            }
            continue;
        }

        if (
            candidates.includes(rule) ||
            candidates.includes(ruleNoDot) ||
            candidates.includes(ruleNoDrive) ||
            candidates.includes(ruleBase) ||
            candidates.includes(ruleBaseNoExt)
        ) {
            return rawRule;
        }

        // Path-like explicit rules also match a suffix of the full path.
        if (rule.includes("\\") && (full.endsWith(rule) || fullNoDot.endsWith(ruleNoDot) || fullNoDrive.endsWith(ruleNoDrive))) {
            return rawRule;
        }
    }

    return null;
}
