/**
 * Assemble a self-hosted stand payload — the bind-mount tree deploy/docker-compose.yml expects:
 *
 *   <out>/server.ts            copy of deploy/server.ts
 *   <out>/docker-compose.yml   copy of deploy/docker-compose.yml
 *   <out>/dist/                `bun run build` output, with a catalog listing ONLY this stand's games
 *   <out>/apps/<id>.wgb        the bundles those entries point at
 *
 * A stand is defined by a JSON config kept OUTSIDE the repo (it names private bundle
 * and cover paths):
 *
 *   { "out": "G:/WGB/my-stand",
 *     "games": [{ "id": "montezuma", "name": "...", "subtitle": "", "description": "...",
 *                 "year": "2007", "genre": "Puzzle",
 *                 "wgb": "G:/WGB/running/montezuma.wgb",
 *                 "cover": "C:/.../montezuma-box.jpg" }] }
 *
 * Usage:  bun run build && bun tools/make-stand.ts <stand.json> [--out DIR]
 */
import fs from "fs";
import path from "path";

interface StandGame {
    id: string;
    name: string;
    subtitle?: string;
    description: string;
    year: string;
    genre: string;
    wgb: string;
    cover: string;
    preload?: boolean;
}

interface StandConfig {
    out?: string;
    /** Default for every game: download bundles to OPFS before starting (no on-demand
     *  streaming). Worth it wherever range round-trips cost real latency. Per-game
     *  `preload` overrides it. */
    preload?: boolean;
    games: StandGame[];
}

const REPO = path.resolve(import.meta.dir, "..");

function fail(msg: string): never {
    console.error(`make-stand: ${msg}`);
    process.exit(1);
}

const args = process.argv.slice(2);
const configPath = args.find((a) => !a.startsWith("--"));
if (!configPath) fail("usage: bun tools/make-stand.ts <stand.json> [--out DIR]");
const outFlag = args.indexOf("--out");

const config: StandConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const out = path.resolve(outFlag >= 0 ? args[outFlag + 1] : config.out ?? fail("no `out` in config and no --out"));
if (!config.games?.length) fail("config has no games");

const distSrc = path.join(REPO, "dist");
if (!fs.existsSync(path.join(distSrc, "index.html"))) fail(`no build in ${distSrc} — run \`bun run build\` first`);

const distOut = path.join(out, "dist");
const appsOut = path.join(out, "apps");
fs.rmSync(distOut, { recursive: true, force: true });
fs.mkdirSync(appsOut, { recursive: true });
fs.cpSync(distSrc, distOut, { recursive: true });

// The stand's library is exactly its games: drop the public build's box art so no
// unrelated cover is reachable by URL on a private stand.
const coversOut = path.join(distOut, "covers");
fs.rmSync(coversOut, { recursive: true, force: true });
fs.mkdirSync(coversOut, { recursive: true });

const catalog = config.games.map((g) => {
    if (!fs.existsSync(g.wgb)) fail(`missing bundle for "${g.id}": ${g.wgb}`);
    if (!fs.existsSync(g.cover)) fail(`missing cover for "${g.id}": ${g.cover}`);
    const coverName = path.basename(g.cover);
    fs.copyFileSync(g.wgb, path.join(appsOut, `${g.id}.wgb`));
    fs.copyFileSync(g.cover, path.join(coversOut, coverName));
    return {
        id: g.id,
        name: g.name,
        subtitle: g.subtitle ?? "",
        wgbUrl: `/apps/${g.id}.wgb`,
        coverUrl: `/covers/${coverName}`,
        description: g.description,
        year: g.year,
        genre: g.genre,
        preload: g.preload ?? config.preload ?? false,
        enabled: true,
    };
});

fs.writeFileSync(path.join(distOut, "games-catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
fs.copyFileSync(path.join(REPO, "deploy", "server.ts"), path.join(out, "server.ts"));
// The compose file is deployment-local config once it lands (passwords, host paths,
// network name), so ship the template only when the stand doesn't have one yet.
const compose = path.join(out, "docker-compose.yml");
if (!fs.existsSync(compose)) fs.copyFileSync(path.join(REPO, "deploy", "docker-compose.yml"), compose);

const mb = (p: string) => (fs.statSync(p).size / 1048576).toFixed(1);
console.log(`stand payload → ${out}`);
for (const g of catalog) console.log(`  ${g.id.padEnd(20)} ${mb(path.join(appsOut, `${g.id}.wgb`))} MB  ${g.name}`);
console.log(`  dist/ + server.ts + docker-compose.yml`);
