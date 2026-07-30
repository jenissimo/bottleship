/**
 * Auto-discovery barrel for inner-loop HLE descriptors: every libs/<id>/index.ts
 * self-registers into libRegistry at import time; the Vite glob makes dropping
 * a new library directory sufficient — no manual import list anywhere (same
 * pattern as api-registry.ts's *.api.ts glob).
 *
 * Adding a directory while `bun run dev` is ALREADY running needs this file touched (or
 * the server restarted): the glob is expanded at transform time and the cached result
 * does not know about a directory that did not exist when it was produced. A page reload
 * is not enough, and the symptom is a descriptor that simply never detects.
 *
 * The call MUST stay a literal `import.meta.glob(...)` — Vite transforms it at
 * compile time only in that exact form (assigning it to a variable defeats the
 * transform). Under bun test `import.meta.glob` is undefined and the call
 * throws; the try/catch makes it a no-op there (tests import the specific
 * descriptor/kernel they exercise directly).
 */
try {
    void import.meta.glob('./*/index.ts', { eager: true });
} catch {
    /* non-Vite runtime (bun test): descriptors imported directly by tests */
}
