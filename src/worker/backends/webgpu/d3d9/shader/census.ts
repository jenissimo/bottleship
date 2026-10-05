import { Op, opName } from "./sm-enums";

export type CensusStatus = "ok" | "approximated" | "unsupported";
export type CensusKind = "flow" | "alu" | "tex";
export type CensusOpcode = number | string;

export interface CensusRecord {
    op: CensusOpcode;
    name: string;
    kind: CensusKind;
    status: CensusStatus;
}

export interface CensusPolicy {
    failLink: boolean;
}

/** Unsupported instructions invalidate the link; approximations remain explicitly linkable. */
export function censusPolicy(status: CensusStatus): CensusPolicy {
    return { failLink: status === "unsupported" };
}

const FLOW_OPS = new Set<number>([
    Op.CALL, Op.CALLNZ, Op.LOOP, Op.RET, Op.ENDLOOP, Op.LABEL,
    Op.REP, Op.ENDREP, Op.IF, Op.IFC, Op.ELSE, Op.ENDIF,
    Op.BREAK, Op.BREAKC, Op.BREAKP, Op.SETP,
]);

const TEX_OPS = new Set<number>([
    Op.TEXCOORD, Op.TEXKILL, Op.TEX, Op.TEXBEM, Op.TEXBEML,
    Op.TEXREG2AR, Op.TEXREG2GB, Op.TEXM3x2PAD, Op.TEXM3x2TEX,
    Op.TEXM3x3PAD, Op.TEXM3x3TEX, Op.TEXM3x3SPEC, Op.TEXM3x3VSPEC,
    Op.TEXREG2RGB, Op.TEXDP3TEX, Op.TEXM3x2DEPTH, Op.TEXDP3,
    Op.TEXM3x3, Op.TEXDEPTH, Op.DSX, Op.DSY, Op.TEXLDD, Op.TEXLDL,
]);

function opcodeName(op: CensusOpcode): string {
    return typeof op === "number" ? opName(op) : op;
}

function namedOpcodeKind(name: string): CensusKind {
    const normalized = name.toLowerCase();
    if (
        normalized === "call" || normalized === "callnz" || normalized === "loop" ||
        normalized === "ret" || normalized === "endloop" || normalized === "label" ||
        normalized === "rep" || normalized === "endrep" || normalized === "if" ||
        normalized === "ifc" || normalized === "else" || normalized === "endif" ||
        normalized === "break" || normalized === "breakc" || normalized === "breakp" ||
        normalized === "setp" || normalized.startsWith("if_") || normalized.startsWith("breakc_")
    ) return "flow";
    if (
        normalized.startsWith("tex") || normalized === "dsx" || normalized === "dsy"
    ) return "tex";
    return "alu";
}

export function opcodeKind(op: CensusOpcode): CensusKind {
    if (typeof op === "string") return namedOpcodeKind(op);
    if (FLOW_OPS.has(op)) return "flow";
    if (TEX_OPS.has(op)) return "tex";
    return "alu";
}

export class CensusError extends Error {
    constructor(readonly record: CensusRecord) {
        super(`Unsupported ${record.kind} opcode ${record.name} cannot be linked`);
        this.name = "CensusError";
    }

    get code(): "unsupported-flow" {
        return "unsupported-flow";
    }
}

export interface CensusSummary {
    total: number;
    ok: number;
    approximated: number;
    unsupported: number;
    unsupportedOps: string[];
    approximatedOps: string[];
}

export class Census {
    private readonly entries: CensusRecord[] = [];
    private firstLinkError: CensusError | null = null;

    record(op: CensusOpcode, status: CensusStatus, kind = opcodeKind(op)): CensusRecord {
        const record: CensusRecord = { op, name: opcodeName(op), kind, status };
        this.entries.push(record);
        if (this.firstLinkError === null && censusPolicy(status).failLink) {
            this.firstLinkError = new CensusError(record);
        }
        return record;
    }

    records(): readonly CensusRecord[] {
        return this.entries;
    }

    count(status: CensusStatus): number {
        let count = 0;
        for (const entry of this.entries) if (entry.status === status) count++;
        return count;
    }

    linkError(): CensusError | null {
        return this.firstLinkError;
    }

    assertLinkable(): void {
        if (this.firstLinkError !== null) throw this.firstLinkError;
    }

    summary(): CensusSummary {
        const unsupportedOps: string[] = [];
        const approximatedOps: string[] = [];
        for (const entry of this.entries) {
            if (entry.status === "unsupported") unsupportedOps.push(entry.name);
            if (entry.status === "approximated") approximatedOps.push(entry.name);
        }
        return {
            total: this.entries.length,
            ok: this.count("ok"),
            approximated: this.count("approximated"),
            unsupported: this.count("unsupported"),
            unsupportedOps,
            approximatedOps,
        };
    }
}

export { Census as OpcodeCensus };
