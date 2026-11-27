import { readFileSync } from "node:fs";

const hypercall = readFileSync(new URL("../../public/wwt-hypercall.wasm", import.meta.url));
const module = new WebAssembly.Module(hypercall);
const imports = WebAssembly.Module.imports(module);
if (imports.length !== 1 || imports[0].module !== "env" || imports[0].name !== "memory" || imports[0].kind !== "memory") {
    throw new Error("WWT hypercall must import only the guest memory");
}

let cursor = 8;
while (cursor < hypercall.length) {
    const section = hypercall[cursor++];
    let size = 0, shift = 0, byte;
    do {
        byte = hypercall[cursor++];
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
    } while (byte & 0x80);
    if (section === 5 || section === 8 || section === 11 || section === 12) {
        throw new Error("WWT hypercall cannot define memory, start code or data segments in the guest. Section: " + section);
    }
    cursor += size;
}
const hasStack = WebAssembly.Module.exports(module).some(entry => entry.name === "__stack_pointer" && entry.kind === "global");
if (!hasStack) throw new Error("WWT hypercall has no relocatable stack pointer");

const arena = new WebAssembly.Module(readFileSync(new URL("../../public/wwt-d3d9-arena.wasm", import.meta.url)));
if (!WebAssembly.Module.exports(arena).some(entry => entry.name === "memory" && entry.kind === "memory")) {
    throw new Error("D3D9 arena must export its own memory");
}
