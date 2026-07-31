import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { transform } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "node:child_process";
import type { ServerResponse } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Truthful build id for the About panel: Cloudflare Pages exposes the deployed
// commit as CF_PAGES_COMMIT_SHA; locally fall back to `git rev-parse`. Baked in
// via `define` below and read as the __BUILD_SHA__ global.
const BUILD_SHA = (
  process.env.CF_PAGES_COMMIT_SHA ||
  (() => { try { return execSync("git rev-parse --short HEAD").toString().trim(); } catch { return "dev"; } })()
).slice(0, 7);
// HTTP is the default (localhost is a secure context, so SharedArrayBuffer /
// COOP-COEP work over plain HTTP and automation needn't clear a self-signed
// cert). Opt into a self-signed HTTPS dev/preview server with VITE_SSL=1.
const useSsl = !!process.env.VITE_SSL;

const coopCoepHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
};

function audioWorkletPlugin(): Plugin {
  const src = path.resolve(__dirname, "src/audio/bottleship-audio-worklet.ts");
  const out = path.resolve(__dirname, "src/audio/bottleship-audio-worklet.js");

  async function compile() {
    const code = fs.readFileSync(src, "utf-8");
    const result = await transform(code, { loader: "ts", target: "esnext" });
    fs.writeFileSync(out, result.code);
  }

  return {
    name: "audio-worklet",
    async buildStart() {
      await compile();
    },
    configureServer(server) {
      server.watcher.on("change", async (file) => {
        if (path.normalize(file) === path.normalize(src)) {
          await compile();
          console.log("[audio-worklet] Recompiled bottleship-audio-worklet.js");
        }
      });
    },
  };
}

// Minimal /health endpoint so `harness up` (tools/harness.ts) can probe the Vite
// dev server's liveness the same way it probes the log server (:3001/health).
// Without this, Vite was the only one of the three services with no health check.
function harnessHealthPlugin(): Plugin {
  return {
    name: "harness-health",
    configureServer(server) {
      server.middlewares.use("/health", (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end("OK");
      });
    },
  };
}

// Dev-only: stream a .wgb bundle straight off disk, replacing the old (dangerous)
// public/apps/external-wgb symlink into an external drive — a cleanup (`git clean -fdx`
// / rm) once followed that symlink and wiped the drive. The ABSOLUTE path is supplied by
// the caller as `?path=` (the agent/harness knows it programmatically; `make-wgb` prints a
// ready URL; a dev "load by path" field pastes it) — nothing is hardcoded and no symlink
// lives in the repo tree, so no cleanup can ever recurse into a real drive again. Full HTTP
// Range support (206, suffix `bytes=-N`) so the worker's synchronous on-demand streaming
// loader (SyncHttpRangeSource) works — a server that ignores Range is exactly what breaks it.
// A ROM read is one Range request, so a bundle boot issues hundreds of them against a
// multi-GB file. `.pipe(res)` alone leaks the descriptor whenever the client goes away
// before the body is drained (aborted prefetch, page reload mid-load) — the stream stays
// open with nothing consuming it, and a long-lived dev server accumulates them until
// every further read crawls. Destroy the stream when the response closes.
function pipeAndCleanup(stream: fs.ReadStream, res: ServerResponse): void {
  res.on("close", () => stream.destroy());
  stream.on("error", () => { stream.destroy(); if (!res.writableEnded) res.end(); });
  stream.pipe(res);
}

function serveWgbFromDisk(): Plugin {
  const ROUTE = "/__wgb/";
  return {
    name: "serve-wgb-from-disk",
    apply: "serve",
    configureServer(server) {
      // Registered in the body (not a returned post-hook) so it runs BEFORE Vite's
      // internal static/SPA-fallback middlewares and reliably intercepts the route.
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith(ROUTE)) return next();
        for (const [k, v] of Object.entries(coopCoepHeaders)) res.setHeader(k, v);
        // Caller supplies the absolute disk path via ?path= (URLSearchParams decodes it).
        const qi = req.url.indexOf("?");
        const abs = qi >= 0 ? new URLSearchParams(req.url.slice(qi + 1)).get("path") : null;
        if (!abs) { res.statusCode = 400; res.end("missing ?path=<absolute .wgb path>"); return; }
        const file = path.resolve(abs);
        if (!file.toLowerCase().endsWith(".wgb")) { res.statusCode = 403; res.end("only .wgb files"); return; }
        let size: number;
        try {
          const st = fs.statSync(file);
          if (!st.isFile()) { res.statusCode = 404; res.end(`not a file: ${file}`); return; }
          size = st.size;
        } catch { res.statusCode = 404; res.end(`not found: ${file}`); return; }
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Type", "application/octet-stream");
        const range = req.headers["range"];
        const m = typeof range === "string" ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
        if (m) {
          let start: number, end: number;
          if (m[1] === "" && m[2] !== "") { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
          else { start = parseInt(m[1], 10); end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1); }
          if (Number.isNaN(start) || start > end || start >= size) {
            res.statusCode = 416; res.setHeader("Content-Range", `bytes */${size}`); res.end(); return;
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          res.setHeader("Content-Length", String(end - start + 1));
          if (req.method === "HEAD") { res.end(); return; }
          pipeAndCleanup(fs.createReadStream(file, { start, end }), res);
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Length", String(size));
        if (req.method === "HEAD") { res.end(); return; }
        pipeAndCleanup(fs.createReadStream(file), res);
      });
    },
  };
}

// public/apps/ holds multi-GB bundled demo .wgb games (built locally by tools/internal/
// build-*-demo-wgb.ts, gitignored). The dev server serves public/ live without copying, and
// production serves games from an external mount (never bundled) — so the default copyPublicDir
// only ever wasted minutes/gigabytes on `vite build`. Copy everything else, skip apps/.
// (BYO games and agent/make-wgb loads stream off disk via serveWgbFromDisk — never in public/.)
function copyPublicDirExceptApps(): Plugin {
  return {
    name: "copy-public-dir-except-apps",
    apply: "build",
    closeBundle() {
      const publicDir = path.resolve(__dirname, "public");
      const outDir = path.resolve(__dirname, "dist");
      if (!fs.existsSync(publicDir)) return;
      fs.mkdirSync(outDir, { recursive: true });
      for (const entry of fs.readdirSync(publicDir, { withFileTypes: true })) {
        if (entry.name === "apps") continue;
        fs.cpSync(path.join(publicDir, entry.name), path.join(outDir, entry.name), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
  },
  plugins: [
    audioWorkletPlugin(),
    harnessHealthPlugin(),
    serveWgbFromDisk(),
    copyPublicDirExceptApps(),
    ...useSsl ? [basicSsl()] : [],
    react({
      jsxRuntime: "automatic"
    })
  ],
  worker: {
    format: "es",
    // Safari does not support dynamic import() / chunk-loading inside module
    // workers — it rejects the first worker chunk load with a misleading
    // "AbortError: Cross-origin script load denied by CORS policy". Inlining
    // all dynamic imports collapses the worker into a single file with zero
    // chunk loads, so there is nothing for Safari to choke on. Chrome is
    // unaffected. See emulator.worker.ts (await import PageTableManager, etc.).
    rollupOptions: {
      output: { codeSplitting: false }
    }
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    ...useSsl ? { https: true } : {},
    hmr: false,
    watch: {
      // Chokidar registers one fs.watch handle PER FILE and its defaults ignore only
      // .git/node_modules/the cache dir. These trees hold no importable module and tens of
      // thousands of files (logs/ is appended continuously by the dev sidecar), and watching
      // them saturates the libuv threadpool for minutes after listen — the dev server answers
      // nothing until the watcher settles.
      // Forward slashes: picomatch treats backslashes as escapes, so a path.resolve() result
      // would never match on Windows.
      ignored: ["logs", ".claude", "tmp", ".ghidra-home"].map(
        (d) => path.resolve(__dirname, d).replace(/\\/g, "/") + "/**"
      )
    },
    headers: coopCoepHeaders
  },
  preview: {
    host: true,
    ...useSsl ? { https: true } : {},
    headers: coopCoepHeaders
  },
  resolve: {
    alias: {
      react: path.resolve(__dirname, "./node_modules/react"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
      v86: path.resolve(__dirname, "./vendor/v86/build/libv86.mjs"),
      "@bottleship/formats": path.resolve(__dirname, "./packages/formats/src"),
      "@bottleship/repack": path.resolve(__dirname, "./packages/repack/src")
    }
  },
  build: {
    emptyOutDir: false,
    // We copy public/ ourselves (copyPublicDirExceptApps) — Vite's built-in publicDir
    // copy would drag every public/apps/*.wgb (plus the dev-only external-wgb symlink
    // to a network drive) into dist on every build.
    copyPublicDir: false
  },
  optimizeDeps: {
    // Pre-bundling is not optional here: @phosphor-icons/react is a large barrel and
    // react/react-dom are CJS needing an ESM wrapper, so unbundled a single dev page load
    // would be thousands of requests.
    //
    // This lists every bare import in the BROWSER tree and only that: `include` bundles a
    // package whole, so naming an unused one is pure cost, while a dep the scanner discovers
    // mid-session forces a re-optimization whose page reload has to travel over HMR — which is
    // disabled above. Without that signal the page keeps requesting `?v=<hash>` URLs that no
    // longer exist and every fresh module hangs while the server still looks alive.
    //
    // No `force`: it discards a valid cache on every start, and each re-run can re-hit the
    // Windows failure where the optimizer's output is left in `node_modules/.vite-temp` and
    // never renamed into `.vite/deps`, after which every dep request 504s.
    include: ["react", "react-dom", "@phosphor-icons/react", "pako"]
  }
});
