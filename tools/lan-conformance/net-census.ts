/**
 * net-census — network slice of the API census.
 *
 * Aggregates `tools/api-census.ts --json` outputs over the bundle libraries
 * and prints the ranked remaining NETWORK work (ws2_32/wsock32/dplayx/dpnet/
 * dpnlobby/dpvoice), the backlog that drives lanprobe case order.
 *
 * Known reading caveat: the census export index is a static scan, so APIs
 * registered at runtime (ordinal aliases in wsa-blocking.ts, dynamically
 * built export tables) show as "unimplemented" even when implemented —
 * verify a row against the HLE source before turning it into work.
 *
 * Usage:
 *   bun tools/api-census.ts <dir> --json --out logs/census-a.json   (first)
 *   bun tools/lan-conformance/net-census.ts logs/census-a.json [more.json...]
 */
const NET_MODULES = new Set([
    "ws2_32", "wsock32", "ws2help", "mswsock",
    "dplayx", "dpnet", "dpnlobby", "dpvoice", "dpmodemx",
]);

const files = process.argv.slice(2);
if (!files.length) {
    console.error("usage: net-census.ts <api-census --json output> [more...]");
    process.exit(2);
}

interface WorkOrderRow {
    dll: string; name: string; status: string; score: number; callSites: number;
    importers?: string[];
}
interface CensusBundle {
    bundle: string; workOrder?: WorkOrderRow[];
    totals?: Record<string, number>;
}

interface AggRow {
    dll: string; name: string; statuses: Set<string>; callSites: number;
    bundles: Set<string>; importers: Set<string>;
}

const agg = new Map<string, AggRow>();
const bundlesWithNetWork = new Set<string>();
let bundleCount = 0;

for (const file of files) {
    const data = await Bun.file(file).json() as CensusBundle | CensusBundle[];
    for (const b of Array.isArray(data) ? data : [data]) {
        bundleCount++;
        for (const w of b.workOrder ?? []) {
            if (!NET_MODULES.has(w.dll)) continue;
            bundlesWithNetWork.add(b.bundle);
            const key = `${w.dll}!${w.name}`;
            const row = agg.get(key) ?? {
                dll: w.dll, name: w.name, statuses: new Set<string>(),
                callSites: 0, bundles: new Set<string>(), importers: new Set<string>(),
            };
            row.statuses.add(w.status);
            row.callSites += w.callSites ?? 0;
            row.bundles.add(b.bundle);
            for (const i of w.importers ?? []) row.importers.add(i);
            agg.set(key, row);
        }
    }
}

const rows = [...agg.values()].sort((a, b) =>
    b.callSites - a.callSites || b.bundles.size - a.bundles.size || a.dll.localeCompare(b.dll));

console.log(`bundles: ${bundleCount}, with network work: ${bundlesWithNetWork.size}, distinct network rows: ${rows.length}`);
for (const r of rows) {
    const imp = [...r.importers].slice(0, 2).join(",");
    console.log(
        String(r.callSites).padStart(5),
        `${r.bundles.size}b`,
        [...r.statuses].join("+").padEnd(14),
        `${r.dll}:${r.name}`,
        "->", imp,
    );
}
