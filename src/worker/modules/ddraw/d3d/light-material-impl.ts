/**
 * IDirect3DLight and IDirect3DMaterial3 interface implementations.
 *
 * D3D retained-mode objects used by D3D2/D3D3 games (e.g. Thief, Dark Engine).
 * Lights are created via CreateLight, configured via SetLight, attached via Viewport::AddLight.
 * Materials are created via CreateMaterial, configured via SetMaterial, bound via GetHandle + SetLightState.
 */
import { Logger, LogCategory } from "../../../core/logger";
import { DDrawContext } from "../context";
import { Direct3DLightObject, Direct3DMaterial3Object } from "../com-objects";
import { bytesToGuid } from "../helpers";
import { isValidAddress } from "../../../core/memory/address-guard";
import {
    IID_IDirect3DMaterial,
    IID_IDirect3DMaterial2,
    IID_IDirect3DMaterial3,
    allocateComObject,
} from "../constants";
import { D3DExports, D3D_OK, D3DERR_INVALIDCALL } from "./types";
import { D3DLight7Data, D3DMaterial7Data, D3DColorValue, D3DVector } from "./types";

const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const E_FAIL = 0x80004005;
const DDERR_ALREADYINITIALIZED = 0x88760005; // MAKE_DDHRESULT(5)
const DDERR_UNSUPPORTED = 0x80004001; // ddraw.h: DDERR_UNSUPPORTED == E_NOTIMPL

// ============================================================================
// Helper: read/write D3DCOLORVALUE (16 bytes: r,g,b,a as f32)
// ============================================================================
function readColorValue(view: DataView, addr: number): D3DColorValue {
    return {
        r: view.getFloat32(addr, true),
        g: view.getFloat32(addr + 4, true),
        b: view.getFloat32(addr + 8, true),
        a: view.getFloat32(addr + 12, true),
    };
}

function writeColorValue(view: DataView, addr: number, c: D3DColorValue): void {
    view.setFloat32(addr, c.r, true);
    view.setFloat32(addr + 4, c.g, true);
    view.setFloat32(addr + 8, c.b, true);
    view.setFloat32(addr + 12, c.a, true);
}

// ============================================================================
// Helper: read/write D3DVECTOR (12 bytes: x,y,z as f32)
// ============================================================================
function readVector(view: DataView, addr: number): D3DVector {
    return {
        x: view.getFloat32(addr, true),
        y: view.getFloat32(addr + 4, true),
        z: view.getFloat32(addr + 8, true),
    };
}

function writeVector(view: DataView, addr: number, v: D3DVector): void {
    view.setFloat32(addr, v.x, true);
    view.setFloat32(addr + 4, v.y, true);
    view.setFloat32(addr + 8, v.z, true);
}

// ============================================================================
// D3DLIGHT2 structure offsets (80 bytes)
// ============================================================================
// dwSize(0), dltType(4), dcvColor(8..23), dvPosition(24..35), dvDirection(36..47),
// dvRange(48), dvFalloff(52), dvAttenuation0(56), dvAttenuation1(60), dvAttenuation2(64),
// dvTheta(68), dvPhi(72), dwFlags(76)
const LIGHT2_SIZE = 80;
const LIGHT2_OFF = {
    dwSize: 0,
    dltType: 4,
    dcvColor: 8,      // D3DCOLORVALUE (16 bytes)
    dvPosition: 24,   // D3DVECTOR (12 bytes)
    dvDirection: 36,  // D3DVECTOR (12 bytes)
    dvRange: 48,
    dvFalloff: 52,
    dvAttenuation0: 56,
    dvAttenuation1: 60,
    dvAttenuation2: 64,
    dvTheta: 68,
    dvPhi: 72,
    dwFlags: 76,
};

// ============================================================================
// D3DMATERIAL structure offsets (76 bytes)
// ============================================================================
// dwSize(0), diffuse(4..19), ambient(20..35), specular(36..51), emissive(52..67), power(68), hTexture(72)
const MAT_SIZE = 76;
const MAT_OFF = {
    dwSize: 0,
    diffuse: 4,       // D3DCOLORVALUE (16 bytes)
    ambient: 20,
    specular: 36,
    emissive: 52,
    power: 68,
    hTexture: 72,
};

const readIid = (mem: Uint8Array, riidPtr: number): string =>
    bytesToGuid(mem.slice(riidPtr, riidPtr + 16));

export const createLightMaterialExports = (context: DDrawContext): D3DExports => {
    const exports: D3DExports = {};
    const resourceProvider = context.resourceProvider;

    // ========================================================================
    // IDirect3DLight
    // ========================================================================

    exports["IDirect3DLight_QueryInterface"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        if (!obj) return E_NOINTERFACE;
        return obj.queryInterface(readIid(mem, args[1]), args[2], mem);
    };

    exports["IDirect3DLight_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirect3DLight_Release"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    exports["IDirect3DLight_Initialize"] = () => D3D_OK;

    // IDirect3DLight::SetLight(this, lpLight)
    exports["IDirect3DLight_SetLight"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpLight = args[1];

        // Borrowed pointer: validate the whole struct once, then read it through a hoisted
        // view (CLAUDE.md 3.1 — the check belongs at the boundary, not on every field).
        if (!lpLight || !isValidAddress(mem, lpLight, LIGHT2_SIZE, "r")) return D3DERR_INVALIDCALL;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DLightObject | null;
        if (!obj) return 0x80004002;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const dwSize = view.getUint32(lpLight + LIGHT2_OFF.dwSize, true);

        const data: D3DLight7Data = {
            type: view.getUint32(lpLight + LIGHT2_OFF.dltType, true),
            diffuse: readColorValue(view, lpLight + LIGHT2_OFF.dcvColor),
            specular: { r: 0, g: 0, b: 0, a: 0 }, // D3DLIGHT2 has single color, not separate specular
            ambient: { r: 0, g: 0, b: 0, a: 0 },
            position: readVector(view, lpLight + LIGHT2_OFF.dvPosition),
            direction: readVector(view, lpLight + LIGHT2_OFF.dvDirection),
            range: view.getFloat32(lpLight + LIGHT2_OFF.dvRange, true),
            falloff: view.getFloat32(lpLight + LIGHT2_OFF.dvFalloff, true),
            attenuation0: view.getFloat32(lpLight + LIGHT2_OFF.dvAttenuation0, true),
            attenuation1: view.getFloat32(lpLight + LIGHT2_OFF.dvAttenuation1, true),
            attenuation2: view.getFloat32(lpLight + LIGHT2_OFF.dvAttenuation2, true),
            theta: view.getFloat32(lpLight + LIGHT2_OFF.dvTheta, true),
            phi: view.getFloat32(lpLight + LIGHT2_OFF.dvPhi, true),
        };

        // D3DLIGHT2 dwFlags: D3DLIGHT_ACTIVE (0x01)
        if (dwSize >= LIGHT2_SIZE) {
            const dwFlags = view.getUint32(lpLight + LIGHT2_OFF.dwFlags, true);
            obj.setActive(!!(dwFlags & 0x01));
        }

        obj.setLightData(data);

        Logger.log(LogCategory.SYSTEM,
            `IDirect3DLight_SetLight: type=${data.type} active=${obj.isActive()} ` +
            `color=(${data.diffuse.r.toFixed(2)},${data.diffuse.g.toFixed(2)},${data.diffuse.b.toFixed(2)})`);

        return D3D_OK;
    };

    // IDirect3DLight::GetLight(this, lpLight)
    exports["IDirect3DLight_GetLight"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpLight = args[1];

        if (!lpLight || !isValidAddress(mem, lpLight, LIGHT2_SIZE, "rw")) return D3DERR_INVALIDCALL;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DLightObject | null;
        if (!obj) return 0x80004002;

        const data = obj.getLightData();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        view.setUint32(lpLight + LIGHT2_OFF.dwSize, LIGHT2_SIZE, true);
        view.setUint32(lpLight + LIGHT2_OFF.dltType, data.type, true);
        writeColorValue(view, lpLight + LIGHT2_OFF.dcvColor, data.diffuse);
        writeVector(view, lpLight + LIGHT2_OFF.dvPosition, data.position);
        writeVector(view, lpLight + LIGHT2_OFF.dvDirection, data.direction);
        view.setFloat32(lpLight + LIGHT2_OFF.dvRange, data.range, true);
        view.setFloat32(lpLight + LIGHT2_OFF.dvFalloff, data.falloff, true);
        view.setFloat32(lpLight + LIGHT2_OFF.dvAttenuation0, data.attenuation0, true);
        view.setFloat32(lpLight + LIGHT2_OFF.dvAttenuation1, data.attenuation1, true);
        view.setFloat32(lpLight + LIGHT2_OFF.dvAttenuation2, data.attenuation2, true);
        view.setFloat32(lpLight + LIGHT2_OFF.dvTheta, data.theta, true);
        view.setFloat32(lpLight + LIGHT2_OFF.dvPhi, data.phi, true);
        view.setUint32(lpLight + LIGHT2_OFF.dwFlags, obj.isActive() ? 0x01 : 0x00, true);

        return D3D_OK;
    };

    // ========================================================================
    // IDirect3DMaterial3
    // ========================================================================

    // The three material versions are NOT one vtable: v1 carries Initialize plus the
    // Reserve/Unreserve tail (9 slots), v2/v3 are 6. So QI hands back a tear-off over
    // the requested version's table, aliased to the same object — material data and the
    // D3DMATERIALHANDLE must stay shared however the guest reached the material.
    const materialTearOffs = new WeakMap<object, Map<string, number>>();
    const materialVTableByIid: Record<string, string> = {
        [IID_IDirect3DMaterial.toLowerCase()]: "IDirect3DMaterial",
        [IID_IDirect3DMaterial2.toLowerCase()]: "IDirect3DMaterial2",
        [IID_IDirect3DMaterial3.toLowerCase()]: "IDirect3DMaterial3",
    };

    exports["IDirect3DMaterial3_QueryInterface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const ppvObject = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr);
        if (!obj) return E_NOINTERFACE;
        if (!ppvObject || !isValidAddress(mem, ppvObject, 4, "rw")) return E_POINTER;
        if (!args[1] || !isValidAddress(mem, args[1], 16, "r")) return E_POINTER;

        const iidStr = readIid(mem, args[1]);
        const vtableKey = materialVTableByIid[iidStr.replace(/[{}]/g, "").toLowerCase()];
        if (!vtableKey) return obj.queryInterface(iidStr, ppvObject, mem);

        const vtableAddr = context.vtables[vtableKey]?.address;
        if (!vtableAddr) {
            Logger.warn(LogCategory.COM, `IDirect3DMaterial_QueryInterface: no vtable for ${vtableKey}`);
            return E_NOINTERFACE;
        }

        obj.addRef();
        if (vtableAddr === obj.vtableAddress) {
            new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(ppvObject, thisPtr, true);
            return D3D_OK;
        }

        // One address per (material, version): QueryInterface is idempotent in COM and a
        // game may compare the pointers it gets back, so a fresh block per call is wrong.
        let cache = materialTearOffs.get(obj);
        if (!cache) {
            cache = new Map();
            materialTearOffs.set(obj, cache);
        }
        let objAddr = cache.get(vtableKey) ?? 0;
        if (!objAddr) {
            objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
            if (!objAddr) {
                obj.release();
                return E_FAIL;
            }
            cache.set(vtableKey, objAddr);
            resourceProvider.mapAddressToHandle(objAddr, obj.handle);
            Logger.log(LogCategory.COM,
                `IDirect3DMaterial_QueryInterface -> ${vtableKey} at 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
        }
        new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(ppvObject, objAddr, true);
        return D3D_OK;
    };

    exports["IDirect3DMaterial3_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirect3DMaterial3_Release"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    // IDirect3DMaterial3::SetMaterial(this, lpMat)
    exports["IDirect3DMaterial3_SetMaterial"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpMat = args[1];

        if (!lpMat || !isValidAddress(mem, lpMat, MAT_SIZE, "r")) return D3DERR_INVALIDCALL;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DMaterial3Object | null;
        if (!obj) return 0x80004002;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const data: D3DMaterial7Data = {
            diffuse: readColorValue(view, lpMat + MAT_OFF.diffuse),
            ambient: readColorValue(view, lpMat + MAT_OFF.ambient),
            specular: readColorValue(view, lpMat + MAT_OFF.specular),
            emissive: readColorValue(view, lpMat + MAT_OFF.emissive),
            power: view.getFloat32(lpMat + MAT_OFF.power, true),
        };

        obj.setMaterialData(data);

        Logger.log(LogCategory.SYSTEM,
            `IDirect3DMaterial3_SetMaterial: diffuse=(${data.diffuse.r.toFixed(2)},${data.diffuse.g.toFixed(2)},${data.diffuse.b.toFixed(2)}) ` +
            `power=${data.power.toFixed(1)}`);

        return D3D_OK;
    };

    // IDirect3DMaterial3::GetMaterial(this, lpMat)
    exports["IDirect3DMaterial3_GetMaterial"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpMat = args[1];

        if (!lpMat || !isValidAddress(mem, lpMat, MAT_SIZE, "rw")) return D3DERR_INVALIDCALL;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DMaterial3Object | null;
        if (!obj) return 0x80004002;

        const data = obj.getMaterialData();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        view.setUint32(lpMat + MAT_OFF.dwSize, MAT_SIZE, true);
        writeColorValue(view, lpMat + MAT_OFF.diffuse, data.diffuse);
        writeColorValue(view, lpMat + MAT_OFF.ambient, data.ambient);
        writeColorValue(view, lpMat + MAT_OFF.specular, data.specular);
        writeColorValue(view, lpMat + MAT_OFF.emissive, data.emissive);
        view.setFloat32(lpMat + MAT_OFF.power, data.power, true);

        return D3D_OK;
    };

    // IDirect3DMaterial3::GetHandle(this, lpDirect3DDevice, lpHandle)
    exports["IDirect3DMaterial3_GetHandle"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpHandle = args[2];

        if (!lpHandle || !isValidAddress(mem, lpHandle, 4, "rw")) return D3DERR_INVALIDCALL;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DMaterial3Object | null;
        if (!obj) return 0x80004002;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpHandle, obj.getMaterialHandle(), true);

        Logger.log(LogCategory.SYSTEM,
            `IDirect3DMaterial3_GetHandle -> 0x${obj.getMaterialHandle().toString(16)}`);

        return D3D_OK;
    };

    // IDirect3DMaterial (v1) and IDirect3DMaterial2 — identical semantics; v1 sits one
    // slot lower from Initialize on, which the descriptors already encode.
    const materialSharedMethods = ["QueryInterface", "AddRef", "Release", "SetMaterial", "GetMaterial", "GetHandle"];
    for (const method of materialSharedMethods) {
        const m3key = `IDirect3DMaterial3_${method}`;
        if (!exports[m3key]) continue;
        exports[`IDirect3DMaterial_${method}`] = exports[m3key];
        exports[`IDirect3DMaterial2_${method}`] = exports[m3key];
    }
    // Initialize on an already-created material is a legacy no-op (DDERR_ALREADYINITIALIZED).
    exports["IDirect3DMaterial_Initialize"] = () => DDERR_ALREADYINITIALIZED;
    // Reserve/Unreserve were never implemented by DirectX itself.
    exports["IDirect3DMaterial_Reserve"] = () => DDERR_UNSUPPORTED;
    exports["IDirect3DMaterial_Unreserve"] = () => DDERR_UNSUPPORTED;

    return exports;
};
