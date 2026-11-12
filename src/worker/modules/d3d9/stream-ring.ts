export function d3d9StreamRingEnabled(): boolean {
    return (globalThis as { __d3d9StreamRing?: boolean }).__d3d9StreamRing !== false;
}
