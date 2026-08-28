/** Public shader API; implementation is orchestrated by link/index.ts. */
export {
    parseShader,
    PROG_BIND,
    compileVertexShader,
    compilePixelShader,
    computeCubeMask,
    computeVolumeMask,
    computeVertexVolumeMask,
    linkProgram,
    hybridTexcoordSetForStage,
} from "./link/index";
export type {
    RawVertexElement,
    CompiledVs,
    CompiledPs,
    LinkResult,
    LinkOptions,
} from "./link/index";
