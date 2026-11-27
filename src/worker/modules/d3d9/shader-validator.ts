/**
 * IDirect3DShaderValidator9 + Direct3DShaderValidatorCreate9
 *
 * Undocumented D3D9 export used by D3DX (fxc / effect compiler) to validate
 * shader bytecode before CreateVertexShader / CreatePixelShader.
 * Reference: Wine d3d9_main.c, DXVK d3d9_shader_validator.cpp
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { Op } from '../../backends/webgpu/d3d9/shader/sm-enums';
import { createComObject, getVTables } from './shared-state';

const D3D_OK = 0;
const E_FAIL = 0x80004005;
const E_POINTER = 0x80004003;

enum ValidatorPhase {
    Begin = 0,
    ValidatingHeader = 1,
    ValidatingInstructions = 2,
    EndOfShader = 3,
    Error = 4,
}

type ValidatorSession = {
    phase: ValidatorPhase;
};

// @participant(d3d9)
const validators = new Map<number, ValidatorSession>();

export const captureShaderValidators = (): Array<[number, number]> =>
    [...validators].sort((a, b) => a[0] - b[0]).map(([ptr, v]) => [ptr, v.phase] as [number, number]);

export const restoreShaderValidators = (saved: Array<[number, number]>): void => {
    validators.clear();
    for (const [ptr, phase] of saved) validators.set(ptr, { phase });
};

export function resetShaderValidators(): void {
    validators.clear();
}

function isShaderVersionToken(token: number): boolean {
    const progType = (token >>> 16) & 0xffff;
    return progType === 0xfffe || progType === 0xffff;
}

function readDwordTokens(mem: Uint8Array, pdwInst: number, cdw: number): Uint32Array | null {
    if (!pdwInst || cdw === 0) return new Uint32Array(0);
    const tokens = new Uint32Array(cdw);
    for (let i = 0; i < cdw; i++) {
        const value = Mem.readUint32(pdwInst + i * 4);
        if (value === null) return null;
        tokens[i] = value;
    }
    return tokens;
}

function chunkHasEndToken(tokens: Uint32Array): boolean {
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] >>> 0;
        if ((token & 0xffff) === Op.END || token === 0x0000ffff) {
            return true;
        }
    }
    return false;
}

export function createShaderValidatorExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const queryInterface = (_ctx: unknown, _mem: Uint8Array, args: number[]): number => {
        const thisPtr = args[0] >>> 0;
        const ppvObject = args[2] >>> 0;
        if (!ppvObject) return E_POINTER;
        if (!Mem.writeUint32(ppvObject, thisPtr)) return E_POINTER;
        return D3D_OK;
    };

    exports['IDirect3DShaderValidator9_QueryInterface'] = queryInterface;
    exports['IDirect3DShaderValidator9_AddRef'] = () => 2;
    exports['IDirect3DShaderValidator9_Release'] = () => 1;

    exports['IDirect3DShaderValidator9_Begin'] = (_ctx, _mem, args) => {
        const pValidator = args[0] >>> 0;
        const session = validators.get(pValidator);
        if (!session) return E_FAIL;

        if (session.phase !== ValidatorPhase.Begin) {
            Logger.warn(LogCategory.D3D9, 'ShaderValidator::Begin called out of order');
            session.phase = ValidatorPhase.Error;
            return E_FAIL;
        }

        session.phase = ValidatorPhase.ValidatingHeader;
        Logger.verbose(LogCategory.D3D9, `ShaderValidator::Begin(0x${pValidator.toString(16)})`);
        return D3D_OK;
    };

    exports['IDirect3DShaderValidator9_Instruction'] = (_ctx, mem, args) => {
        const pValidator = args[0] >>> 0;
        const pdwInst = args[3] >>> 0;
        const cdw = args[4] >>> 0;

        const session = validators.get(pValidator);
        if (!session) return E_FAIL;

        if (session.phase === ValidatorPhase.Error) return E_FAIL;
        if (session.phase === ValidatorPhase.Begin) {
            Logger.warn(LogCategory.D3D9, 'ShaderValidator::Instruction before Begin');
            session.phase = ValidatorPhase.Error;
            return E_FAIL;
        }
        if (session.phase === ValidatorPhase.EndOfShader) {
            Logger.warn(LogCategory.D3D9, 'ShaderValidator::Instruction after end token');
            session.phase = ValidatorPhase.Error;
            return E_FAIL;
        }

        // Sims 2 / some D3DX paths pass cdw=0 — treat as no-op.
        if (!pdwInst || cdw === 0) return D3D_OK;

        const tokens = readDwordTokens(mem, pdwInst, cdw);
        if (!tokens) {
            session.phase = ValidatorPhase.Error;
            return E_FAIL;
        }

        if (session.phase === ValidatorPhase.ValidatingHeader) {
            if (cdw !== 1 || !isShaderVersionToken(tokens[0]!)) {
                Logger.warn(
                    LogCategory.D3D9,
                    `ShaderValidator: bad version token cdw=${cdw} token=0x${(tokens[0] ?? 0).toString(16)}`,
                );
                session.phase = ValidatorPhase.Error;
                return E_FAIL;
            }
            session.phase = ValidatorPhase.ValidatingInstructions;
            return D3D_OK;
        }

        if (chunkHasEndToken(tokens)) {
            session.phase = ValidatorPhase.EndOfShader;
        }
        return D3D_OK;
    };

    exports['IDirect3DShaderValidator9_End'] = (_ctx, _mem, args) => {
        const pValidator = args[0] >>> 0;
        const session = validators.get(pValidator);
        if (!session) return E_FAIL;

        if (session.phase === ValidatorPhase.Error) return E_FAIL;
        if (session.phase === ValidatorPhase.Begin) {
            Logger.warn(LogCategory.D3D9, 'ShaderValidator::End before Begin/Instruction');
            session.phase = ValidatorPhase.Error;
            return E_FAIL;
        }
        if (session.phase !== ValidatorPhase.EndOfShader) {
            Logger.warn(LogCategory.D3D9, 'ShaderValidator::End without end token');
            session.phase = ValidatorPhase.Error;
            return E_FAIL;
        }

        session.phase = ValidatorPhase.Begin;
        Logger.verbose(LogCategory.D3D9, `ShaderValidator::End(0x${pValidator.toString(16)})`);
        return D3D_OK;
    };

    exports['Direct3DShaderValidatorCreate9'] = () => {
        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DShaderValidator9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DShaderValidator9 vtable not found');
            return 0;
        }

        const ptr = createComObject(vtableAddr);
        validators.set(ptr, { phase: ValidatorPhase.Begin });
        Logger.log(LogCategory.D3D9, `Direct3DShaderValidatorCreate9 -> 0x${ptr.toString(16)}`);
        return ptr;
    };

    return exports;
}
