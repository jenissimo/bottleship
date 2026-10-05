#!/usr/bin/env node
// Downloads the Arch state image used by the BYTEmark benchmark into the local
// images cache. The 9p filesystem chunks (images/arch/) are NOT pre-downloaded —
// run-bytemark.mjs lazy-mirrors them on first use.
//
// Usage: node fetch-images.mjs [--images <dir>] [--state v2|v3]

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[i + 1];
}

const imagesDir = path.resolve(args.images || path.join(__dirname, "images"));
const version = args.state || "v2";
const name = `arch_state-${version}.bin.zst`;
const dest = path.join(imagesDir, name);

fs.mkdirSync(imagesDir, { recursive: true });
for (const [file, dst] of [[name, dest], ["fs.json", path.join(imagesDir, "fs.json")]]) {
    if (fs.existsSync(dst)) { console.log(`already present: ${dst}`); continue; }
    const src = `https://i.copy.sh/${file}`;
    console.log(`fetching ${src} ...`);
    const res = await fetch(src);
    if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dst, buf);
    console.log(`saved ${dst} (${buf.length} bytes)`);
}
