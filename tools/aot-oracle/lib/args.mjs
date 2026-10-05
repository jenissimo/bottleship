// aot-oracle — command-line parsing that refuses what it does not understand.
//
// Every script here used to accept any `--word` and ignore the ones it did not read. That is
// the project's dominant bug class: `--flags "5=0"` was accepted, dropped, and the run then
// reported a number for the DEFAULT codegen shape while labelling itself an ablation. An
// option this tool cannot honour must stop the run, not decorate it.

/**
 * @param {string[]} argv process.argv
 * @param {string[]} known every option this script reads, without the leading "--"
 * @returns {Record<string,string>} raw string values ("1" for a bare flag)
 * @throws on an unknown option, a positional argument, or a repeated option
 */
export function parseArgs(argv, known) {
    const args = {};
    const set = new Set(known);
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}" — this tool takes only --options`);
        const name = a.slice(2);
        if (!set.has(name)) {
            throw new Error(`unknown option --${name}\n  known: ${[...known].sort().map((k) => "--" + k).join(" ")}`);
        }
        if (name in args) throw new Error(`option --${name} given twice`);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) { args[name] = next; i++; }
        else args[name] = "1";
    }
    return args;
}

/** Parse `--flags "5=0,21=1"` into a Map, refusing anything that is not int=int. */
export function parseFlagOverrides(spec) {
    const out = new Map();
    for (const pair of String(spec || "").split(",").map((s) => s.trim()).filter(Boolean)) {
        const [i, v] = pair.split("=").map(Number);
        if (!Number.isFinite(i) || !Number.isFinite(v) || !Number.isInteger(i) || !Number.isInteger(v)) {
            throw new Error(`bad --flags entry "${pair}" — expected <index>=<value>`);
        }
        out.set(i, v);
    }
    return out;
}

/** Usage failure: one line on stderr, exit 2. Nothing runs on a misunderstood command line. */
export function usageExit(e) {
    process.stderr.write(`${e.message ?? e}\n`);
    process.exit(2);
}
