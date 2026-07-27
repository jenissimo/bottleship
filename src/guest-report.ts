// Crash/exit report machinery for the host shell. CrashFault mirrors the
// worker's CrashFaultPayload (src/worker/core/system.ts); formatGuestReport
// renders it as plain text for the clipboard / a bug report.

// Crash fault record forwarded from the worker's single fault entry point
// (the #PF handler → faultRecorder). Drives the in-UI crash report.
// Harness-grade fields mirror HarnessReport in worker/harness/build-report.ts.
export interface CrashFault {
  /** Human label for the crash class, e.g. "Unhandled access violation". */
  reason?: string;
  eip: number;
  faultAddr: number;
  errorCode?: number;
  threadId?: number | null;
  lastThunk?: string;
  regs?: { ecx: number; ebx: number; esp: number; ebp: number; esi: number; edi: number } | null;
  /** Alias of lastThunks — kept for older worker builds. */
  recentCalls?: string[];
  lastThunks?: string[];
  gameEsp?: number;
  stackDump?: number[];
  cpu?: {
    eip?: number;
    eipSym?: string | null;
    eflags?: number;
    fsBase?: number;
    regs?: { eax: number; ecx: number; edx: number; ebx: number; esp: number; ebp: number; esi: number; edi: number };
    segments?: { es: number; cs: number; ss: number; ds: number; fs: number; gs: number } | null;
  } | null;
  backtrace?: Array<{ i: number; ret: number | string; sym: string | null; isThunk: boolean }>;
  stubs?: Array<{ api: string; id?: string; count: number; firstCaller: number | string; firstCallerSym: string | null }>;
  getProcMisses?: Array<{
    module: number | string; proc: string; count: number;
    firstCaller: number | string; firstCallerSym: string | null;
    lastCaller?: number | string; lastCallerSym?: string | null;
  }>;
  silentStubs?: Array<{ api: string; count: number; arity?: number; lastCaller: number | string; lastCallerSym: string | null }>;
  recentGetProc?: Array<{
    module: string; proc: string; addr: string | null; kind?: string;
    caller: string; callerSym: string | null;
  }>;
  getProcStubbed?: Array<{
    module: string; proc: string; kind: string; count: number;
    lastCaller: number | string; lastCallerSym: string | null;
  }>;
  faults?: Array<{ eip: string; faultAddr: string; lastThunk: string; threadId: number | null }>;
  cxxExceptions?: Array<{ seq: number; threadId: number; type: string; thrown: string; throwModule: string; rethrow: boolean; outcome: string; caughtBy: string }>;
  recentFaults?: Array<{ eip: number; faultAddr: number; lastThunk: string; threadId: number | null; kind: string }>;
  threads?: {
    currentThreadId?: number | null;
    runQueue?: number[];
    count?: number;
    threads?: Array<{
      id: number;
      handle?: number;
      state?: number;
      stateName?: string | null;
      waitReason?: number | null;
      waitReasonName?: string | null;
      eip?: number;
      eipSym?: string | null;
      esp?: number;
      tebAddress?: number;
      suspendCount?: number;
      priority?: number;
      running?: boolean;
    }>;
  } | Array<{
    id: number;
    stateName: string | null;
    waitReasonName: string | null;
    eip: number;
    eipSym: string | null;
    esp: number;
    running: boolean;
  }>;
  schedulerDetail?: string | null;
  asyncRestoreTrace?: string[];
  crashThreadCalls?: string[];
  wildEsp?: string | null;
  wildEbp?: string | null;
  asyncRetMismatch?: string | null;
  /** Escape forensics: RET-shape suspect slot + SEH-window/guard-violation cross-refs. */
  escapeAnalysis?: string[];
  /** Parked-stack write-guard violations (plant-time tripwire, JS stack at write time). */
  stackGuardViolations?: string[];
  /** Recent SEH catch dispatches with descent windows + WILD-EBP notes. */
  sehDispatchTrace?: string[];
}

// Set when the guest process exits (ExitProcess / crash → SEH → ExitProcess).
// `crashed` distinguishes a clean exit from an unhandled access violation
// (fault carries EIP/addr).
export interface GuestExitInfo {
  code: number;
  crashed?: boolean;
  fault?: CrashFault;
}

/** Format a guest exit/crash fault into plain text for the clipboard / a bug report. */
export function formatGuestReport(f: CrashFault, gameName: string, crashed: boolean): string {
  const hx = (v: number | string | undefined | null) => {
    if (v == null) return "0x0";
    if (typeof v === "string") return v.startsWith("0x") ? v : `0x${v}`;
    return "0x" + (v >>> 0).toString(16);
  };
  const lines: string[] = [
    crashed ? `BottleShip crash report` : `BottleShip exit report`,
    `game: ${gameName}`,
  ];
  if (crashed) {
    lines.push(
      `fault: ${f.reason || "unhandled access violation"}`,
      `EIP=${hx(f.eip)} addr=${hx(f.faultAddr)} errorCode=${hx(f.errorCode)} thread=T${f.threadId ?? "?"}`,
    );
  } else {
    lines.push(
      `exit: ${f.reason || "ExitProcess"}`,
      `EIP=${hx(f.eip)} thread=T${f.threadId ?? "?"}`,
    );
  }
  lines.push(`last thunk: ${f.lastThunk || "unknown"}`);
  if (f.wildEsp) {
    lines.push(`!! ${f.wildEsp}`);
  }
  if (f.wildEbp) {
    lines.push(`!! ${f.wildEbp}`);
  }
  if (f.asyncRetMismatch) {
    lines.push(`!! ${f.asyncRetMismatch}`);
  }
  if (f.escapeAnalysis?.length) {
    lines.push(``, `escape analysis:`, ...f.escapeAnalysis.map((l) => `  ${l}`));
  }
  if (f.stackGuardViolations?.length) {
    lines.push(``, `!! parked-stack write violations (JS machinery wrote a parked thread's live stack; newest last):`,
      ...f.stackGuardViolations.map((v) => `  ${v}`));
  }
  // Prefer the full CPU snapshot (all 8 regs + eflags + segments) when present; else the
  // 6-reg fault subset.
  if (f.cpu?.regs) {
    const r = f.cpu.regs;
    const eipLine = f.cpu.eip != null
      ? `cpu: EIP=${hx(f.cpu.eip)}${f.cpu.eipSym ? ` ${f.cpu.eipSym}` : ""}`
      : null;
    if (eipLine) lines.push(eipLine);
    lines.push(
      `regs: EAX=${hx(r.eax)} ECX=${hx(r.ecx)} EDX=${hx(r.edx)} EBX=${hx(r.ebx)}`,
      `      ESP=${hx(r.esp)} EBP=${hx(r.ebp)} ESI=${hx(r.esi)} EDI=${hx(r.edi)}`,
      `      EFLAGS=${hx(f.cpu.eflags)} FS_BASE=${hx(f.cpu.fsBase)}`,
    );
    if (f.cpu.segments) {
      const s = f.cpu.segments;
      lines.push(`      CS=${hx(s.cs)} DS=${hx(s.ds)} SS=${hx(s.ss)} ES=${hx(s.es)} FS=${hx(s.fs)} GS=${hx(s.gs)}`);
    }
  } else if (f.regs) {
    lines.push(`regs: ECX=${hx(f.regs.ecx)} EBX=${hx(f.regs.ebx)} ESP=${hx(f.regs.esp)} EBP=${hx(f.regs.ebp)} ESI=${hx(f.regs.esi)} EDI=${hx(f.regs.edi)}`);
  }

  if (f.backtrace?.length) {
    lines.push(``, `backtrace (newest frame first):`,
      ...f.backtrace.map((b) => `  #${b.i} ${hx(b.ret)}${b.isThunk ? " [thunk]" : ""}  ${b.sym ?? "?"}`));
  }
  if (f.stackDump?.length) {
    lines.push(``, `stack dump (32 words from ${hx(f.gameEsp)}):`,
      ...f.stackDump.map((w, i) => `  [+0x${(i * 4).toString(16)}] ${hx(w)}`));
  }
  const lastThunks = f.lastThunks?.length ? f.lastThunks : f.recentCalls;
  if (lastThunks?.length) {
    lines.push(``, `last thunks (newest last):`, ...lastThunks.map((c) => `  ${c}`));
  }
  if (f.crashThreadCalls?.length) {
    lines.push(``, `recent calls on T${f.threadId ?? "?"} (the crashing thread, newest last):`,
      ...f.crashThreadCalls.map((c) => `  ${c}`));
  }
  if (f.threads && !Array.isArray(f.threads) && f.threads.threads?.length) {
    const ts = f.threads;
    lines.push(``, `threads (${ts.count ?? ts.threads!.length}, current=T${ts.currentThreadId ?? "?"}, runQueue=[${(ts.runQueue ?? []).join(",")}]):`,
      ...ts.threads!.map((t) =>
        `  T${t.id} ${t.running ? "*" : " "}[${t.stateName ?? "?"}${t.waitReasonName ? `:${t.waitReasonName}` : ""}] ` +
        `eip=${hx(t.eip)}${t.eipSym ? ` ${t.eipSym}` : ""} esp=${hx(t.esp)} ` +
        `handle=${hx(t.handle)} teb=${hx(t.tebAddress)} prio=${t.priority ?? 0} suspend=${t.suspendCount ?? 0}`));
  } else if (Array.isArray(f.threads) && f.threads.length) {
    lines.push(``, `threads (${f.threads.length}):`,
      ...f.threads.map((t) =>
        `  T${t.id} ${t.running ? "*" : " "}[${t.stateName ?? "?"}${t.waitReasonName ? `:${t.waitReasonName}` : ""}] ` +
        `eip=${hx(t.eip)}${t.eipSym ? ` ${t.eipSym}` : ""} esp=${hx(t.esp)}`));
  }
  if (f.stubs?.length) {
    lines.push(``, `unimplemented thunks (${f.stubs.length}) — a likely "silently exited" culprit:`,
      ...f.stubs.map((s) =>
        `  ${s.api}${s.id ? ` id=${s.id}` : ""} ×${s.count}  first@${hx(s.firstCaller)}${s.firstCallerSym ? ` ${s.firstCallerSym}` : ""}`));
  }
  if (f.getProcMisses?.length) {
    lines.push(``, `GetProcAddress misses (${f.getProcMisses.length}) — exports the guest could not resolve:`,
      ...f.getProcMisses.map((h) =>
        `  ${hx(h.module)}:"${h.proc}" ×${h.count}  first@${hx(h.firstCaller)}${h.firstCallerSym ? ` ${h.firstCallerSym}` : ""}` +
        (h.lastCaller != null ? `  last@${hx(h.lastCaller)}${h.lastCallerSym ? ` ${h.lastCallerSym}` : ""}` : "")));
  }
  if (f.recentGetProc?.length) {
    lines.push(``, `recent GetProcAddress (${f.recentGetProc.length}, newest last):`,
      ...f.recentGetProc.map((h) =>
        `  ${h.module}:"${h.proc}" → ${h.addr ?? "NULL"}${h.kind ? ` [${h.kind}]` : ""}  caller=${h.caller}${h.callerSym ? ` ${h.callerSym}` : ""}`));
  }
  if (f.getProcStubbed?.length) {
    lines.push(``, `GetProcAddress resolved to a stub (${f.getProcStubbed.length}) — the guest was told these exist:`,
      ...f.getProcStubbed.map((h) =>
        `  ${h.module}:"${h.proc}" [${h.kind}] ×${h.count}  last@${hx(h.lastCaller)}${h.lastCallerSym ? ` ${h.lastCallerSym}` : ""}`));
  }
  if (f.silentStubs?.length) {
    lines.push(``, `suspected silent stubs (implemented but ignore args) (${f.silentStubs.length}):`,
      ...f.silentStubs.map((s) =>
        `  ${s.api}${s.arity != null ? ` arity=${s.arity}` : ""} ×${s.count}  last@${hx(s.lastCaller)}${s.lastCallerSym ? ` ${s.lastCallerSym}` : ""}`));
  }
  if (f.cxxExceptions?.length) {
    lines.push(``, `recent C++ exceptions (newest last) — 'unhandled' is the usual terminate root:`,
      ...f.cxxExceptions.map((e) =>
        `  #${e.seq} T${e.threadId} ${e.type || "?"}${e.rethrow ? " (rethrow)" : ""} [${e.outcome}${e.caughtBy ? ` by ${e.caughtBy}` : ""}] @${e.throwModule || "?"}${e.thrown ? `  "${e.thrown}"` : ""}`));
  }
  if (f.faults?.length) {
    lines.push(``, `recent page faults (newest last):`,
      ...f.faults.map((pf) => `  eip=${pf.eip} addr=${pf.faultAddr} T${pf.threadId ?? "?"} ${pf.lastThunk || ""}`.trimEnd()));
  } else if (f.recentFaults?.length) {
    lines.push(``, `recent page faults (newest last):`,
      ...f.recentFaults.map((pf) => `  eip=${hx(pf.eip)} addr=${hx(pf.faultAddr)} [${pf.kind}] T${pf.threadId ?? "?"} ${pf.lastThunk || ""}`.trimEnd()));
  }
  if (f.schedulerDetail) {
    lines.push(``, `scheduler:`, `  ${f.schedulerDetail}`);
  }
  if (f.sehDispatchTrace?.length) {
    lines.push(``, `recent SEH catch dispatches (newest last):`, ...f.sehDispatchTrace.map((t) => `  ${t}`));
  }
  if (f.asyncRestoreTrace?.length) {
    lines.push(``, `async restore trace (newest last):`, ...f.asyncRestoreTrace.map((t) => `  ${t}`));
  }
  return lines.join("\n");
}
