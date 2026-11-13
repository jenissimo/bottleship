/** Stop only the process listening on the selected development server port. */
export function stopDevServerListener(devUrl: string): void {
    // By PID via the listening socket — matching 'vite' on the command line kills every
    // Vite on the machine, including other agents' and other checkouts'.
    const port = new URL(devUrl).port || "5174";
    if (process.platform !== "win32") {
        const pids = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]).stdout.toString().split(/\s+/).filter(Boolean);
        if (pids.length > 0) Bun.spawnSync(["kill", ...pids]);
        return;
    }
    Bun.spawnSync(["powershell", "-NoProfile", "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
        `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`]);
}
