/** Register facts shared by the vertex and pixel analyses. */

import type { SmProgram } from "../sm-parser";

export interface RegisterUsage {
    maxTemp: number;
    maxConst: number;
    maxBool: number;
    usesRelativeConst: boolean;
}

/** Keep stage-specific semantic analysis small by centralising parser-derived register facts. */
export function analyzeRegisterUsage(program: SmProgram): RegisterUsage {
    return {
        maxTemp: program.maxTemp,
        maxConst: program.maxConst,
        maxBool: program.maxBool,
        usesRelativeConst: program.usesRelativeConst,
    };
}

