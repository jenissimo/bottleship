/**
 * IDirect3D, IDirect3D2, IDirect3D3 and IDirect3D7 interface implementations
 */
import { Logger, LogCategory } from "../../../core/logger";
import { ComObjectFactory } from "../../../core/com/base-com-object";
import { allocateComObject, COM_OBJECT_SIZE } from "../../../core/com/com-memory";
import { Marshaler } from "../../../core/memory/marshaler";
import { DDrawContext } from "../context";
import { bytesToGuid } from "../helpers";
import { resolveDDrawTearOff } from "../com-tearoff";
import {
    IID_IDirect3DDevice3,
    IID_IDirect3DDevice3V5,
    IID_IDirect3DDevice7,
    IID_IDirect3DViewport3,
    IID_IDirect3DLight,
    IID_IDirect3DMaterial3,
    IID_IDirect3DVertexBuffer,
    DDPF_ZBUFFER,
    DDPF_STENCILBUFFER,
    DDPIXELFORMAT_Z_OFFSETS,
} from "../constants";
import {
    Direct3DDevice3Object,
    Direct3DDevice7Object,
    Direct3DVertexBufferObject,
    Direct3DViewport3Object,
    Direct3DLightObject,
    Direct3DMaterial3Object,
} from "../com-objects";
import { D3DExports, D3D_OK, D3DERR_INVALIDCALL, D3DColorValue } from "./types";
import { processVertices } from "./process-vertices";
import { D3DRENDERSTATE_LIGHTING } from "../constants";
import {
    fillDeviceDesc,
    fillDeviceDesc7,
    zBufferMask,
    D3DDEVICEDESC7_SIZE,
    D3D7_HAL_DEVICE_GUID_BYTES,
    D3D7_RGB_DEVICE_GUID_BYTES,
    D3D7_TNLHAL_DEVICE_GUID_BYTES,
    d3d7DeviceKindForGuidBytes,
} from "./d3d-caps-utils";
import { computeFvfStride } from "../../../backends/webgpu/ddraw/compute/vertex-converter";
import { EmulatorConfig } from "../../../core/emulator-config-manager";
import { initReturnPtr } from "../../../backends/webgpu/shared/dx-com-helpers";
import { isValidAddress } from "../../../core/memory/address-guard";

/** D3DFINDDEVICERESULT: dwSize + GUID + two D3DDEVICEDESCs (252 each). */
const FIND_DEVICE_RESULT_SIZE = 20 + 252 + 252;

// ddraw.h aliases these onto the standard COM codes, not MAKE_DDHRESULT values.
const DDERR_INVALIDPARAMS = 0x80070057; // E_INVALIDARG
const DDERR_UNSUPPORTED = 0x80004001;   // E_NOTIMPL

/** D3DCOLORVALUE (0..1 floats) -> D3DCOLOR (0xAARRGGBB), the FVF colour encoding. */
const colorValueToArgb = (c?: D3DColorValue): number => {
    if (!c) return 0xffffffff;
    const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    return ((q(c.a) << 24) | (q(c.r) << 16) | (q(c.g) << 8) | q(c.b)) >>> 0;
};

/**
 * Depth formats EnumZBufferFormats offers, in the order real drivers list them (wine
 * ddraw.c d3d7_EnumZBufferFormats) — 16-bit first, because an app that accepts the first
 * usable entry must not be pushed onto a 32-bit buffer it did not want.
 *
 * Only formats the ddraw executor's depth24plus-stencil8 attachment genuinely backs are
 * listed. That leaves out S1_UINT_D15 and S4X4_UINT_D24, whose 1- and 4-bit stencils are a
 * stencil width we do not have; D24S8 is in, and without it the stencil ops advertised in
 * dwStencilCaps are unreachable, since a game can only get stencil by picking a format that
 * carries it.
 *
 * dwZBufferBitDepth names the DEPTH, not the surface width — and drivers disagreed on it for
 * X8D24: some said 24, some 32, and the pitch is a 32-bpp pitch either way. Vista and newer
 * enumerate BOTH spellings (wine bug 22434), so the trailing entry repeats X8D24 with 24 for
 * an app that only accepts a "24-bit" depth buffer. readPixelFormat is what keeps its surface
 * 32 bpp wide.
 */
const Z_BUFFER_FORMATS: ReadonlyArray<{
    bitDepth: number;
    stencilBitDepth: number;
    zBitMask: number;
    stencilBitMask: number;
}> = [
    { bitDepth: 16, stencilBitDepth: 0, zBitMask: 0x0000ffff, stencilBitMask: 0x00000000 }, // D16
    { bitDepth: 32, stencilBitDepth: 0, zBitMask: 0x00ffffff, stencilBitMask: 0x00000000 }, // X8D24
    { bitDepth: 32, stencilBitDepth: 8, zBitMask: 0x00ffffff, stencilBitMask: 0xff000000 }, // D24S8
    { bitDepth: 24, stencilBitDepth: 0, zBitMask: 0x00ffffff, stencilBitMask: 0x00000000 }, // X8D24, 24-bit spelling
];

/** dwZBitMask/dwStencilBitMask are union members over dwGBitMask/dwBBitMask — an app that
 *  computes its DDBLT_DEPTHFILL value from dwZBitMask reads them there. */
const writeZBufferFormat = (view: DataView, addr: number, index: number): void => {
    const f = Z_BUFFER_FORMATS[index];
    const O = DDPIXELFORMAT_Z_OFFSETS;
    view.setUint32(addr + 4, f.stencilBitDepth ? DDPF_ZBUFFER | DDPF_STENCILBUFFER : DDPF_ZBUFFER, true);
    view.setUint32(addr + O.zBufferBitDepth, f.bitDepth, true);
    view.setUint32(addr + O.stencilBitDepth, f.stencilBitDepth, true);
    view.setUint32(addr + O.zBitMask, f.zBitMask, true);
    view.setUint32(addr + O.stencilBitMask, f.stencilBitMask, true);
};

export const createD3DInterfaceExports = (context: DDrawContext): D3DExports => {
    const exports: D3DExports = {};
    const resourceProvider = context.resourceProvider;

    /**
     * IDirect3D* is an interface ON the DirectDraw object, so it must resolve the whole
     * DirectDraw/Direct3D family — notably back to IDirectDraw7, which is how a DX7 app
     * recovers the DirectDraw it needs to create texture surfaces (GetDirect3D, QI, Release).
     */
    const d3dQueryInterface = (iface: string, mem: Uint8Array, args: number[]): number => {
        const thisPtr = args[0];
        const riidPtr = args[1];
        const ppvObject = args[2];

        const obj = resourceProvider.getComObjectByAddress(thisPtr);
        const iidBytes = new Uint8Array(16);
        if (!riidPtr || !isValidAddress(mem, riidPtr, 16, "r")) return 0x80004003;
        for (let i = 0; i < 16; i++) iidBytes[i] = mem[riidPtr + i];
        const iidStr = bytesToGuid(iidBytes);

        Logger.log(LogCategory.COM, `${iface}_QueryInterface: this=0x${thisPtr.toString(16)} iid=${iidStr} obj=${obj ? obj.constructor.name : "null"}`);
        if (!obj) return 0x80004002;
        if (!ppvObject) return 0x80004003;

        const tearOff = resolveDDrawTearOff(context, obj, iidStr.replace(/[{}]/g, "").toLowerCase(), ppvObject, mem);
        if (tearOff !== null) return tearOff;

        return obj.queryInterface(iidStr, ppvObject, mem);
    };

    // --- IDirect3D (v1) ---

    exports["IDirect3D_QueryInterface"] = (ctx, mem, args) => d3dQueryInterface("IDirect3D", mem, args);

    exports["IDirect3D_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef(args[0]) : 0;
    };

    exports["IDirect3D_Release"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release(args[0]) : 0;
    };

    exports["IDirect3D_Initialize"] = () => D3D_OK;

    exports["IDirect3D_EnumDevices"] = (ctx, mem, args) => {
        return exports["IDirect3D3_EnumDevices"]!(ctx, mem, args);
    };

    exports["IDirect3D_CreateViewport"] = (ctx, mem, args) => {
        return exports["IDirect3D3_CreateViewport"]!(ctx, mem, args);
    };
    exports["IDirect3D_CreateLight"] = (ctx, mem, args) => {
        return exports["IDirect3D3_CreateLight"]!(ctx, mem, args);
    };
    // v1 gets the v1 material vtable — Material3's layout is one slot short (no Initialize).
    exports["IDirect3D_CreateMaterial"] = (ctx, mem, args) => {
        return createMaterial(mem, args[1], "IDirect3DMaterial");
    };
    exports["IDirect3D_FindDevice"] = (ctx, mem, args) => {
        return exports["IDirect3D3_FindDevice"]!(ctx, mem, args);
    };

    // --- IDirect3D2 ---

    exports["IDirect3D2_QueryInterface"] = (ctx, mem, args) => d3dQueryInterface("IDirect3D2", mem, args);

    exports["IDirect3D2_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef(args[0]) : 0;
    };

    exports["IDirect3D2_Release"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release(args[0]) : 0;
    };

    exports["IDirect3D2_EnumDevices"] = (ctx, mem, args) => {
        return exports["IDirect3D3_EnumDevices"]!(ctx, mem, args);
    };

    exports["IDirect3D2_CreateDevice"] = (ctx, mem, args) => {
        // IDirect3D2::CreateDevice(this, rclsid, lpDDS, lplpD3DDevice)
        // MUST use IDirect3DDevice2 vtable — Device2 has SwapTextureHandles at
        // index 4, which shifts all subsequent methods by 1 vs Device3.
        // Internally we use a Device3Object for its rich state management, but
        // present the Device2 vtable layout to the guest.
        const lpDDS = args[2];
        const lplpD3DDevice = args[3];
        // initReturnPtr writes through this pointer, so the guard has to precede it.
        if (!lplpD3DDevice || !isValidAddress(mem, lplpD3DDevice, 4, "rw")) return 0x80004003;
        initReturnPtr(lplpD3DDevice);

        const vtableAddr = context.vtables.IDirect3DDevice2?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.SYSTEM, `IDirect3D2_CreateDevice: IDirect3DDevice2 vtable not found!`);
            return 0x80004002;
        }

        // Create a Device3Object (has full state: transforms, render states, etc.)
        // but register it under Device2 IID for COM identity.
        const obj = ComObjectFactory.create(IID_IDirect3DDevice3, vtableAddr) as Direct3DDevice3Object;
        if (!obj) return 0x80004005;

        obj.setParentD3(args[0]);
        obj.setRenderTarget(lpDDS);
        // Device holds a reference on its render target from creation (released in destroy).
        if (lpDDS) resourceProvider.getComObjectByAddress(lpDDS)?.addRef();

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpD3DDevice, objAddr, true);
        resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        Logger.verbose(LogCategory.SYSTEM, `IDirect3D2_CreateDevice -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)}, rt=0x${lpDDS.toString(16)}, vtable=Device2)`);
        return D3D_OK;
    };

    exports["IDirect3D2_CreateLight"] = (ctx, mem, args) => {
        return exports["IDirect3D3_CreateLight"]!(ctx, mem, args);
    };
    exports["IDirect3D2_CreateMaterial"] = (ctx, mem, args) => {
        return exports["IDirect3D3_CreateMaterial"]!(ctx, mem, args);
    };
    exports["IDirect3D2_FindDevice"] = (ctx, mem, args) => {
        return exports["IDirect3D3_FindDevice"]!(ctx, mem, args);
    };
    // CreateViewport must create a real COM object — delegate to D3 version
    // (defined later, patched up after IDirect3D3 exports are created)

    // --- IDirect3D3 ---

    exports["IDirect3D3_QueryInterface"] = (ctx, mem, args) => d3dQueryInterface("IDirect3D3", mem, args);

    exports["IDirect3D3_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef(args[0]) : 0;
    };

    exports["IDirect3D3_Release"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release(args[0]) : 0;
    };

    exports["IDirect3D3_CreateViewport"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lplpViewport = args[1];
        Logger.log(LogCategory.SYSTEM, `IDirect3D3_CreateViewport called: this=0x${thisPtr.toString(16)}, out=0x${lplpViewport.toString(16)}`);

        if (!lplpViewport || !isValidAddress(mem, lplpViewport, 4, "rw")) return 0x80004003;
        initReturnPtr(lplpViewport);

        const vtableAddr = context.vtables.IDirect3DViewport3?.address;
        if (!vtableAddr) return 0x80004002;

        const obj = ComObjectFactory.create(IID_IDirect3DViewport3, vtableAddr);
        if (!obj) return 0x80004005;

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpViewport, objAddr, true);
        resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        Logger.log(LogCategory.SYSTEM, `IDirect3D3_CreateViewport -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
        return D3D_OK;
    };

    // Patch IDirect3D2_CreateViewport to delegate to D3 version
    exports["IDirect3D2_CreateViewport"] = (ctx, mem, args) => {
        return exports["IDirect3D3_CreateViewport"]!(ctx, mem, args);
    };

    exports["IDirect3D3_CreateDevice"] = (ctx, mem, args) => {
        const lpDDS = args[2];
        const lplpD3DDevice = args[3];
        // initReturnPtr writes through this pointer, so the guard has to precede it.
        if (!lplpD3DDevice || !isValidAddress(mem, lplpD3DDevice, 4, "rw")) return 0x80004003;
        initReturnPtr(lplpD3DDevice);

        const vtableAddr = context.vtables.IDirect3DDevice3?.address;
        if (!vtableAddr) return 0x80004002;

        const obj = ComObjectFactory.create(IID_IDirect3DDevice3, vtableAddr) as Direct3DDevice3Object;
        if (!obj) return 0x80004005;

        obj.setParentD3(args[0]);
        obj.setRenderTarget(lpDDS);
        // Device holds a reference on its render target from creation (released in destroy).
        if (lpDDS) resourceProvider.getComObjectByAddress(lpDDS)?.addRef();

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpD3DDevice, objAddr, true);
        resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        Logger.log(LogCategory.SYSTEM, `IDirect3D3_CreateDevice -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)}, rt=0x${lpDDS.toString(16)})`);
        return D3D_OK;
    };

    exports["IDirect3D3_EnumZBufferFormats"] = (ctx, mem, args) => {
        const lpCallback = args[2];
        const lpContext = args[3];

        if (!lpCallback) return 0x80004003;

        const pixelFormatSize = 32;
        const formatAddr = context.process.memory.alloc(pixelFormatSize);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        mem.fill(0, formatAddr, formatAddr + pixelFormatSize);
        view.setUint32(formatAddr, pixelFormatSize, true);
        // IDirect3D3 and IDirect3D7 enumerate the SAME set — the interface version never
        // changed which depth buffers the hardware had.
        const depths = Z_BUFFER_FORMATS;
        let index = 0;

        const callbackManager = context.process.dispatcher.callbackManager;
        callbackManager.saveSuspendedThunkContext(ctx, 16);
        let firstCallbackId: number | null = null;

        const processNext = (): void => {
            if (index >= depths.length) {
                context.process.memory.free(formatAddr);
                return;
            }

            writeZBufferFormat(view, formatAddr, index);
            index++;

            const { callbackId } = callbackManager.invokeCallback(
                lpCallback,
                [formatAddr, lpContext],
                0,
                (callbackReturnValue) => {
                    if (callbackReturnValue === 0) {
                        context.process.memory.free(formatAddr);
                        return D3D_OK;
                    }

                    if (index >= depths.length) {
                        context.process.memory.free(formatAddr);
                        return D3D_OK;
                    }

                    return null;
                }
            );

            if (firstCallbackId === null) {
                firstCallbackId = callbackId;
            }

            const invocation = callbackManager.getPendingCallback(callbackId);
            if (invocation) {
                invocation.enumerationState = {
                    continueEnumeration: processNext,
                    finishEnumeration: () => {
                        context.process.memory.free(formatAddr);
                    }
                };
            }
        };

        processNext();

        return {
            value: 0,
            suspendedForCallback: true,
            callbackId: firstCallbackId || 0,
            stackCleanup: 12
        };
    };

    exports["IDirect3D3_EnumDevices"] = (ctx, mem, args) => {
        const lpCallback = args[1];
        const lpUserArg = args[2];

        if (!lpCallback) return D3DERR_INVALIDCALL;

        const callbackManager = context.process.dispatcher.callbackManager;
        if (!callbackManager) return D3D_OK;

        // Two devices: RGB software (index 0), HAL hardware (index 1)
        const devices = [
            {
                guid: [0x60, 0x5C, 0x66, 0xA4, 0x73, 0x26, 0xCF, 0x11, 0xA3, 0x1A, 0x00, 0xAA, 0x00, 0xB9, 0x33, 0x56],
                name: "RGB Emulation",
                desc: "Microsoft Direct3D RGB Software Emulation",
                fillHal: false, // halDesc zeroed for software device
                fillHel: true,  // helDesc gets full caps
            },
            {
                guid: [0xE0, 0x3D, 0xE6, 0x84, 0xAA, 0x46, 0xCF, 0x11, 0x81, 0x6F, 0x00, 0x00, 0xC0, 0x20, 0x15, 0x6E],
                name: "BottleShip Direct3D HAL",
                desc: "BottleShip Emulator Direct3D Hardware Acceleration",
                fillHal: true,  // halDesc gets full caps for hardware device
                fillHel: false, // helDesc zeroed for HAL
            },
        ];

        const descSize = 252;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let index = 0;
        let firstCallbackId: number | null = null;

        callbackManager.saveSuspendedThunkContext(ctx, 12);

        const processNext = (): void => {
            if (index >= devices.length) return;

            const dev = devices[index];
            index++;

            // Allocate per-device memory
            const halDescAddr = context.process.memory.alloc(descSize);
            const helDescAddr = context.process.memory.alloc(descSize);
            const deviceNameAddr = context.process.memory.alloc(64);
            const deviceDescAddr = context.process.memory.alloc(128);
            const guidAddr = context.process.memory.alloc(16);

            // Write GUID bytes
            for (let i = 0; i < 16; i++) mem[guidAddr + i] = dev.guid[i];

            // Write strings
            Marshaler.writeString(mem, deviceNameAddr, dev.name);
            Marshaler.writeString(mem, deviceDescAddr, dev.desc);

            // Fill descriptors
            mem.fill(0, halDescAddr, halDescAddr + descSize);
            mem.fill(0, helDescAddr, helDescAddr + descSize);
            view.setUint32(halDescAddr, descSize, true);
            view.setUint32(helDescAddr, descSize, true);
            // HEL desc = software rasterizer: HW-only dwDevCaps bits stripped inside.
            if (dev.fillHal) fillDeviceDesc(view, halDescAddr);
            if (dev.fillHel) fillDeviceDesc(view, helDescAddr, true);

            // Callback signature: (GUID*, Description, Name, D3DDEVICEDESC halDesc, D3DDEVICEDESC helDesc, void* userArg)
            const { callbackId } = callbackManager.invokeCallback(
                lpCallback,
                [guidAddr, deviceDescAddr, deviceNameAddr, halDescAddr, helDescAddr, lpUserArg],
                0,
                (callbackReturnValue) => {
                    Logger.log(LogCategory.DDRAW,
                        `IDirect3D3_EnumDevices: callback returned ${callbackReturnValue === 1 ? "DDENUMRET_OK" : "DDENUMRET_CANCEL"} for "${dev.name}"`);

                    // NOTE: do NOT free per-device memory here — same reason as IDirect3D7_EnumDevices:
                    // games may cache the GUID/name/desc pointers from the callback and
                    // read them after EnumDevices returns. One-time small leak (~600 bytes/device).

                    // DDENUMRET_CANCEL (0) = stop enumeration
                    if (callbackReturnValue === 0) return D3D_OK;

                    // No more devices = done
                    if (index >= devices.length) return D3D_OK;

                    // Continue to next device
                    return null;
                }
            );

            if (firstCallbackId === null) firstCallbackId = callbackId;

            const invocation = callbackManager.getPendingCallback(callbackId);
            if (invocation) {
                invocation.enumerationState = {
                    continueEnumeration: processNext,
                    finishEnumeration: () => {}
                };
            }
        };

        processNext();

        return {
            value: 0,
            suspendedForCallback: true,
            callbackId: firstCallbackId || 0,
            stackCleanup: 12
        };
    };

    exports["IDirect3D3_EvictManagedTextures"] = () => D3D_OK;

    // IDirect3D3::CreateLight(this, lplpLight, pUnkOuter)
    exports["IDirect3D3_CreateLight"] = (ctx, mem, args) => {
        const lplpLight = args[1];
        if (!lplpLight || !isValidAddress(mem, lplpLight, 4, "rw")) return 0x80004003; // E_POINTER
        initReturnPtr(lplpLight);

        const vtableAddr = context.vtables.IDirect3DLight?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.SYSTEM, `IDirect3D3_CreateLight: IDirect3DLight vtable not found!`);
            return 0x80004002;
        }

        const obj = ComObjectFactory.create(IID_IDirect3DLight, vtableAddr) as Direct3DLightObject;
        if (!obj) return 0x80004005;

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpLight, objAddr, true);
        resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        Logger.log(LogCategory.SYSTEM, `IDirect3D3_CreateLight -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
        return D3D_OK;
    };

    // IDirect3D3::CreateMaterial(this, lplpMaterial, pUnkOuter)
    /** Shared by every IDirect3D*::CreateMaterial — only the vtable layout differs. */
    const createMaterial = (mem: Uint8Array, lplpMaterial: number, vtableKey: "IDirect3DMaterial" | "IDirect3DMaterial3"): number => {
        if (!lplpMaterial) return 0x80004003; // E_POINTER
        initReturnPtr(lplpMaterial);

        const vtableAddr = context.vtables[vtableKey]?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.SYSTEM, `CreateMaterial: ${vtableKey} vtable not found!`);
            return 0x80004002;
        }

        const obj = ComObjectFactory.create(IID_IDirect3DMaterial3, vtableAddr) as Direct3DMaterial3Object;
        if (!obj) return 0x80004005;

        // Assign a material handle (1-based, unique per material)
        obj.setMaterialHandle(obj.handle);

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpMaterial, objAddr, true);
        resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        Logger.log(LogCategory.SYSTEM, `CreateMaterial(${vtableKey}) -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
        return D3D_OK;
    };

    exports["IDirect3D3_CreateMaterial"] = (ctx, mem, args) => {
        return createMaterial(mem, args[1], "IDirect3DMaterial3");
    };

    // IDirect3D3::FindDevice(this, lpD3DFDS, lpD3DFDR)
    // D3DFINDDEVICESEARCH: dwSize(0), dwFlags(4), bHardware(8), dcmColorModel(12), guid(16..31)
    // D3DFINDDEVICERESULT: dwSize(0), guid(4..19), ddHwDesc(20..271), ddSwDesc(272..523)
    exports["IDirect3D3_FindDevice"] = (ctx, mem, args) => {
        const lpD3DFDS = args[1];
        const lpD3DFDR = args[2];

        if (!lpD3DFDR) return D3DERR_INVALIDCALL;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Log search criteria
        if (lpD3DFDS) {
            const searchFlags = view.getUint32(lpD3DFDS + 4, true);
            const bHardware = view.getUint32(lpD3DFDS + 8, true);
            Logger.log(LogCategory.DDRAW,
                `IDirect3D3_FindDevice: flags=0x${searchFlags.toString(16)} bHardware=${bHardware}`);
        }

        // The result carries two D3DDEVICEDESCs after a 20-byte head; validate the whole
        // thing before the fills below start writing it.
        if (!isValidAddress(mem, lpD3DFDR, FIND_DEVICE_RESULT_SIZE, "rw")) return 0x80004003;
        const resultSize = view.getUint32(lpD3DFDR, true);
        Logger.log(LogCategory.DDRAW, `IDirect3D3_FindDevice: resultSize=${resultSize}`);

        // Fill HAL GUID at offset 4
        const halGuid = [0xE0, 0x3D, 0xE6, 0x84, 0xAA, 0x46, 0xCF, 0x11, 0x81, 0x6F, 0x00, 0x00, 0xC0, 0x20, 0x15, 0x6E];
        for (let i = 0; i < 16; i++) mem[lpD3DFDR + 4 + i] = halGuid[i];

        // Fill ddHwDesc at offset 20 (D3DDEVICEDESC, 252 bytes)
        const hwDescAddr = lpD3DFDR + 20;
        mem.fill(0, hwDescAddr, hwDescAddr + 252);
        view.setUint32(hwDescAddr, 252, true); // dwSize
        fillDeviceDesc(view, hwDescAddr);

        // Fill ddSwDesc at offset 272 (D3DDEVICEDESC, 252 bytes) — software desc,
        // HW-only dwDevCaps bits stripped.
        const swDescAddr = lpD3DFDR + 272;
        mem.fill(0, swDescAddr, swDescAddr + 252);
        view.setUint32(swDescAddr, 252, true); // dwSize
        fillDeviceDesc(view, swDescAddr, true);

        Logger.log(LogCategory.DDRAW, `IDirect3D3_FindDevice: filled result OK`);
        return D3D_OK;
    };

    // IDirect3D3::CreateVertexBuffer(this, lpD3DVertBufDesc, lplpD3DVertBuf, dwFlags, lpUnk)
    exports["IDirect3D3_CreateVertexBuffer"] = (ctx, mem, args) => {
        const lpDesc = args[1];
        const lplpVB = args[2];
        const dwFlags = args[3];

        if (!lpDesc || !lplpVB) return 0x80004003; // E_POINTER
        initReturnPtr(lplpVB);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const dwSize = view.getUint32(lpDesc, true);
        const dwCaps = view.getUint32(lpDesc + 4, true);
        const dwFVF = view.getUint32(lpDesc + 8, true);
        const dwNumVertices = view.getUint32(lpDesc + 12, true);

        const vertexSize = computeFvfStride(dwFVF);
        const totalBytes = vertexSize * dwNumVertices;

        Logger.log(LogCategory.SYSTEM,
            `IDirect3D3_CreateVertexBuffer: caps=0x${dwCaps.toString(16)} fvf=0x${dwFVF.toString(16)} ` +
            `numVerts=${dwNumVertices} vertSize=${vertexSize} total=${totalBytes} flags=0x${dwFlags.toString(16)}`);

        // Allocate guest memory for vertex data
        const dataPtr = context.process.memory.alloc(totalBytes);
        if (!dataPtr) {
            Logger.error(LogCategory.SYSTEM, `IDirect3D3_CreateVertexBuffer: failed to alloc ${totalBytes} bytes`);
            return 0x8876017c; // DDERR_OUTOFMEMORY
        }

        const vtableAddr = context.vtables.IDirect3DVertexBuffer?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.SYSTEM, `IDirect3D3_CreateVertexBuffer: no vtable for IDirect3DVertexBuffer`);
            return 0x80004002;
        }

        const obj = ComObjectFactory.create(IID_IDirect3DVertexBuffer, vtableAddr) as Direct3DVertexBufferObject;
        if (!obj) return 0x80004005;

        obj.setBufferInfo(dataPtr, dwFVF, dwNumVertices, dwCaps, vertexSize);
        obj.setInterfaceVersion(3);

        if (!isValidAddress(mem, lplpVB, 4, "rw")) return 0x80004003;
        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        view.setUint32(lplpVB, objAddr, true);
        resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        Logger.log(LogCategory.SYSTEM,
            `IDirect3D3_CreateVertexBuffer -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)}, data=0x${dataPtr.toString(16)})`);
        return D3D_OK;
    };

    // --- IDirect3DVertexBuffer ---

    exports["IDirect3DVertexBuffer_QueryInterface"] = (ctx, mem, args) => {
        return 0x80004002; // E_NOINTERFACE
    };

    exports["IDirect3DVertexBuffer_AddRef"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const obj = resourceProvider.getComObjectByAddress(thisPtr);
        return obj ? obj.addRef() : 1;
    };

    exports["IDirect3DVertexBuffer_Release"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const obj = resourceProvider.getComObjectByAddress(thisPtr);
        return obj ? obj.release() : 0;
    };

    exports["IDirect3DVertexBuffer_Lock"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwFlags = args[1];
        const lplpData = args[2];
        const lpdwSize = args[3];

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DVertexBufferObject | null;
        if (!obj || !lplpData) return 0x80004003;

        if (!lplpData || !isValidAddress(mem, lplpData, 4, "rw")) return 0x80004003;
        if (lpdwSize && !isValidAddress(mem, lpdwSize, 4, "rw")) return 0x80004003;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpData, obj.getDataPtr(), true);
        if (lpdwSize) {
            view.setUint32(lpdwSize, obj.getNumVertices() * obj.getVertexSize(), true);
        }
        obj.beginLock();

        Logger.verbose(LogCategory.SYSTEM,
            `IDirect3DVertexBuffer_Lock: this=0x${thisPtr.toString(16)} -> data=0x${obj.getDataPtr().toString(16)}`);
        return D3D_OK;
    };

    // Lock/Unlock bracket the guest's own writes into the buffer. The draw path reads the
    // vertex bytes straight out of guest memory at submit time, so there is no host-side
    // copy to flush here — what Unlock owes is the lock bookkeeping itself, so that a
    // double Unlock or an Unlock of a foreign pointer is reported rather than swallowed.
    exports["IDirect3DVertexBuffer_Unlock"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]) as Direct3DVertexBufferObject | null;
        if (!obj) return DDERR_INVALIDPARAMS;
        obj.endLock();
        return D3D_OK;
    };

    /** Current world×view×projection + viewport + lighting inputs for either device version. */
    const vertexPipelineState = (devAddr: number) => {
        const dev = resourceProvider.getComObjectByAddress(devAddr) as
            (Direct3DDevice3Object | Direct3DDevice7Object) | null;
        if (!dev) return null;
        const mvp = dev.getCachedMVP();
        if (!mvp) return null;

        let viewport: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number } | null = null;
        // IDENTITY_CLIP_SPACE unless a legacy D3DVIEWPORT2 asked for a non-default clipping
        // volume / depth range. D3DVIEWPORT7 (device-level SetViewport) has neither: its
        // dvMinZ/dvMaxZ ARE the rasterizer range, so it keeps the identity remap.
        let clipSpace = { sx: 1, sy: 1, sz: 1, ox: 0, oy: 0, oz: 0 };
        if (dev instanceof Direct3DDevice7Object) {
            viewport = dev.getViewportData();
        } else {
            const vpAddr = dev.getCurrentViewport();
            const vpObj = vpAddr ? resourceProvider.getComObjectByAddress(vpAddr) as Direct3DViewport3Object | null : null;
            if (vpObj) {
                const v = vpObj.getViewport();
                clipSpace = vpObj.getClipSpace();
                // The remap already consumed dvMinZ/dvMaxZ; what remains for the rasterizer is [0,1].
                viewport = { x: v.x, y: v.y, width: v.width, height: v.height, minZ: 0, maxZ: 1 };
            }
        }
        if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
            viewport = { x: 0, y: 0, width: context.display.width || 640, height: context.display.height || 480, minZ: 0, maxZ: 1 };
        }

        const material = dev.getMaterial();
        return {
            mvp,
            viewport,
            clipSpace,
            lightingRenderState: dev.getRenderState(D3DRENDERSTATE_LIGHTING) !== 0,
            hasMaterial: dev.isMaterialSet(),
            materialDiffuseArgb: colorValueToArgb(material?.diffuse),
            materialSpecularArgb: colorValueToArgb(material?.specular),
        };
    };

    // IDirect3DVertexBuffer::ProcessVertices(this, dwVertexOp, dwDestIndex, dwCount,
    //                                        lpSrcBuffer, dwSrcIndex, lpD3DDevice, dwFlags)
    // dwFlags (D3DPV_DONOTCOPYDATA) only asks to skip copying unchanged non-position data;
    // copying it unconditionally is always a valid superset, so it is not branched on.
    exports["IDirect3DVertexBuffer_ProcessVertices"] = (ctx, mem, args) => {
        const dstObj = resourceProvider.getComObjectByAddress(args[0]) as Direct3DVertexBufferObject | null;
        const srcObj = resourceProvider.getComObjectByAddress(args[4]) as Direct3DVertexBufferObject | null;
        if (!dstObj || !srcObj) return DDERR_INVALIDPARAMS;

        const state = vertexPipelineState(args[6]);
        if (!state) {
            Logger.warn(LogCategory.DDRAW,
                `IDirect3DVertexBuffer_ProcessVertices: no device state for 0x${args[6].toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        return processVertices(mem, {
            vertexOp: args[1] >>> 0,
            destIndex: args[2] >>> 0,
            srcIndex: args[5] >>> 0,
            count: args[3] >>> 0,
            dstAddr: dstObj.getDataPtr(),
            dstFvf: dstObj.getFVF(),
            dstStride: dstObj.getVertexSize(),
            dstNumVertices: dstObj.getNumVertices(),
            srcAddr: srcObj.getDataPtr(),
            srcFvf: srcObj.getFVF(),
            srcStride: srcObj.getVertexSize(),
            srcNumVertices: srcObj.getNumVertices(),
            // The DX6 buffer lights off the material; the DX7 one off D3DRENDERSTATE_LIGHTING.
            legacyV3: dstObj.getInterfaceVersion() === 3,
            ...state,
        });
    };

    exports["IDirect3DVertexBuffer_GetVertexBufferDesc"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDesc = args[1];

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DVertexBufferObject | null;
        if (!obj || !lpDesc || !isValidAddress(mem, lpDesc, 16, "rw")) return 0x80004003;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpDesc + 0, 16, true);           // dwSize
        view.setUint32(lpDesc + 4, obj.getCaps(), true); // dwCaps
        view.setUint32(lpDesc + 8, obj.getFVF(), true);  // dwFVF
        view.setUint32(lpDesc + 12, obj.getNumVertices(), true); // dwNumVertices

        return D3D_OK;
    };

    exports["IDirect3DVertexBuffer_Optimize"] = () => D3D_OK;

    // --- IDirect3DVertexBuffer7 ---
    // Slots 0-7 are the DX6 buffer verbatim; only the ProcessVerticesStrided tail is new.
    const vertexBuffer7SharedMethods = [
        "QueryInterface", "AddRef", "Release", "Lock", "Unlock",
        "ProcessVertices", "GetVertexBufferDesc", "Optimize",
    ];
    for (const method of vertexBuffer7SharedMethods) {
        const v6key = `IDirect3DVertexBuffer_${method}`;
        if (exports[v6key]) exports[`IDirect3DVertexBuffer7_${method}`] = exports[v6key];
    }

    // ProcessVerticesStrided(this, dwVertexOp, dwDestIndex, dwCount, lpStrideData,
    //                        dwVertexTypeDesc, lpD3DDevice, dwFlags)
    // Gathering the strided arrays is only half the contract — D3DVOP_TRANSFORM et al.
    // must also run the FFP into the destination FVF, and we have no vertex-processing
    // stage on this path. Report it unimplemented rather than returning D3D_OK over a
    // destination buffer we never wrote.
    exports["IDirect3DVertexBuffer7_ProcessVerticesStrided"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwDestIndex = args[2];
        const dwCount = args[3];
        const lpStrideData = args[4];

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DVertexBufferObject | null;
        if (!obj || !lpStrideData) return DDERR_INVALIDPARAMS;
        if (dwDestIndex + dwCount > obj.getNumVertices()) return DDERR_INVALIDPARAMS;

        Logger.warn(LogCategory.SYSTEM,
            `IDirect3DVertexBuffer7_ProcessVerticesStrided: op=0x${args[1].toString(16)} dest=${dwDestIndex} ` +
            `count=${dwCount} fvf=0x${args[5].toString(16)} -> DDERR_UNSUPPORTED (no vertex-processing stage)`);
        return DDERR_UNSUPPORTED;
    };

    // --- IDirect3D7 ---

    exports["IDirect3D7_QueryInterface"] = (ctx, mem, args) => d3dQueryInterface("IDirect3D7", mem, args);

    exports["IDirect3D7_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef(args[0]) : 0;
    };

    exports["IDirect3D7_Release"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release(args[0]) : 0;
    };

    exports["IDirect3D7_CreateDevice"] = (ctx, mem, args) => {
        const rclsid = args[1];
        const lpDDS = args[2];
        const lplpD3DDevice = args[3];
        // initReturnPtr writes through this pointer, so the guard has to precede it.
        if (!lplpD3DDevice || !isValidAddress(mem, lplpD3DDevice, 4, "rw")) return 0x80004003;
        initReturnPtr(lplpD3DDevice);

        const vtableAddr = context.vtables.IDirect3DDevice7?.address;
        if (!vtableAddr) return 0x80004002;

        const obj = ComObjectFactory.create(IID_IDirect3DDevice7, vtableAddr) as Direct3DDevice7Object;
        if (!obj) return 0x80004005;

        // Remember which enumerated device the game asked for (rgb/hal/tnlhal) —
        // IDirect3DDevice7::GetCaps must echo that device's GUID + dwDevCaps split.
        // All three run the same WebGPU path; only the reported identity differs.
        if (rclsid && rclsid + 16 <= mem.length) {
            obj.setD3d7DeviceKind(d3d7DeviceKindForGuidBytes(Array.from(mem.subarray(rclsid, rclsid + 16))));
        }

        obj.setParentD3(args[0]);
        if (lpDDS) obj.setRenderTarget(lpDDS);
        // Device holds a reference on its render target from creation (released in destroy).
        if (lpDDS) resourceProvider.getComObjectByAddress(lpDDS)?.addRef();

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpD3DDevice, objAddr, true);
        resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        Logger.log(LogCategory.SYSTEM, `IDirect3D7_CreateDevice -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)}, rt=0x${(lpDDS || 0).toString(16)}, kind=${obj.getD3d7DeviceKind()})`);
        return D3D_OK;
    };

    exports["IDirect3D7_EnumZBufferFormats"] = (ctx, mem, args) => {
        const lpCallback = args[2];
        const lpContext = args[3];

        if (!lpCallback) return 0x80004003;

        const pixelFormatSize = 32;
        const formatAddr = context.process.memory.alloc(pixelFormatSize);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        mem.fill(0, formatAddr, formatAddr + pixelFormatSize);
        view.setUint32(formatAddr, pixelFormatSize, true);
        const depths = Z_BUFFER_FORMATS;
        let index = 0;

        const callbackManager = context.process.dispatcher.callbackManager;
        callbackManager.saveSuspendedThunkContext(ctx, 16);
        let firstCallbackId: number | null = null;

        const processNext = (): void => {
            if (index >= depths.length) {
                context.process.memory.free(formatAddr);
                return;
            }

            writeZBufferFormat(view, formatAddr, index);
            index++;

            const { callbackId } = callbackManager.invokeCallback(
                lpCallback,
                [formatAddr, lpContext],
                0,
                (callbackReturnValue) => {
                    if (callbackReturnValue === 0) {
                        context.process.memory.free(formatAddr);
                        return D3D_OK;
                    }

                    if (index >= depths.length) {
                        context.process.memory.free(formatAddr);
                        return D3D_OK;
                    }

                    return null;
                }
            );

            if (firstCallbackId === null) {
                firstCallbackId = callbackId;
            }

            const invocation = callbackManager.getPendingCallback(callbackId);
            if (invocation) {
                invocation.enumerationState = {
                    continueEnumeration: processNext,
                    finishEnumeration: () => {
                        context.process.memory.free(formatAddr);
                    }
                };
            }
        };

        processNext();

        return {
            value: 0,
            suspendedForCallback: true,
            callbackId: firstCallbackId || 0,
            stackCleanup: 12
        };
    };

    exports["IDirect3D7_EnumDevices"] = (ctx, mem, args) => {
        const lpCallback = args[1];
        const lpUserArg = args[2];

        if (!lpCallback) return D3DERR_INVALIDCALL;

        const callbackManager = context.process.dispatcher.callbackManager;
        if (!callbackManager) return D3D_OK;

        // Faithful DX7 enumeration on a T&L-era card: THREE devices — RGB software,
        // plain HAL (HW raster, runtime T&L), and the T&L HAL (HWTRANSFORMANDLIGHT).
        // Engines that select HW T&L do it by finding the TnLHal GUID here — without
        // this third device they fall back to their own guest CPU-transform path.
        // Per-device dwDevCaps split lives in fillDeviceDesc7 (keyed off the GUID).
        // Kill switch `__caps7Legacy` restores the old two-device uniform-caps behavior.
        const devices = [
            {
                name: "RGB Emulation",
                desc: "Microsoft Direct3D RGB Software Emulation",
                guid: D3D7_RGB_DEVICE_GUID_BYTES,
            },
            {
                name: "BottleShip Direct3D HAL",
                desc: "BottleShip Emulator Direct3D Hardware Acceleration",
                guid: D3D7_HAL_DEVICE_GUID_BYTES,
            },
            ...((globalThis as Record<string, unknown>).__caps7Legacy === true ? [] : [{
                name: "BottleShip Direct3D T&L HAL",
                desc: "BottleShip Emulator Direct3D Transform & Lighting Hardware Acceleration",
                guid: D3D7_TNLHAL_DEVICE_GUID_BYTES,
            }]),
        ];

        // D3DDEVICEDESC7 is 236 bytes in DX7 headers (includes GUID + reserved tail fields).
        const descSize = D3DDEVICEDESC7_SIZE;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const caps = EmulatorConfig.getInstance().d3dCaps;
        let index = 0;
        let firstCallbackId: number | null = null;
        const readUserArrayState = () => {
            if (!lpUserArg || lpUserArg < 0x10000 || lpUserArg + 0x410 > mem.length) {
                return { modeBase: 0, modeEnd: 0, modeCount: 0 };
            }
            const modeBase = view.getUint32(lpUserArg + 0x408, true); // userArg[0x102]
            const modeEnd = view.getUint32(lpUserArg + 0x40c, true);  // userArg[0x103]
            const modeCount = modeBase && modeEnd >= modeBase ? Math.floor((modeEnd - modeBase) / 0x7c) : 0;
            return { modeBase, modeEnd, modeCount };
        };

        callbackManager.saveSuspendedThunkContext(ctx, 12);

        const processNext = (): void => {
            if (index >= devices.length) return;

            const dev = devices[index];
            index++;

            const descAddr = context.process.memory.alloc(descSize);
            const deviceNameAddr = context.process.memory.alloc(64);
            const deviceDescAddr = context.process.memory.alloc(128);

            Marshaler.writeString(mem, deviceNameAddr, dev.name);
            Marshaler.writeString(mem, deviceDescAddr, dev.desc);

            mem.fill(0, descAddr, descAddr + descSize);
            fillDeviceDesc7(view, descAddr, dev.guid);

            const userState = readUserArrayState();
            if ((globalThis as any).__ddrawVerboseDiag === true) {
                Logger.verbose(
                    LogCategory.DDRAW,
                    `EnumDevices7 pre-callback "${dev.name}": userArg=0x${lpUserArg.toString(16)} ` +
                    `modeBase=0x${userState.modeBase.toString(16)} modeEnd=0x${userState.modeEnd.toString(16)} modeCount=${userState.modeCount}`
                );
            }
            // D3D7 callback: (Description, Name, D3DDEVICEDESC7, UserArg) — no GUID
            const { callbackId } = callbackManager.invokeCallback(
                lpCallback,
                [deviceDescAddr, deviceNameAddr, descAddr, lpUserArg],
                0,
                (callbackReturnValue) => {
                    Logger.log(LogCategory.DDRAW,
                        `IDirect3D7_EnumDevices: callback returned ${callbackReturnValue === 1 ? "DDENUMRET_OK" : "DDENUMRET_CANCEL"} for "${dev.name}"`);

                    // NOTE: do NOT free descAddr/deviceNameAddr/deviceDescAddr here.
                    // Games like THPS2 cache the pointers from the callback and read
                    // them after EnumDevices returns (device name + D3DDEVICEDESC7).
                    // Freeing immediately causes use-after-free → all-zero caps and
                    // empty device name → "TEX too big" and instant ExitProcess.
                    // These are small one-time allocations (~400 bytes/device).

                    if (callbackReturnValue === 0) return D3D_OK;
                    if (index >= devices.length) return D3D_OK;
                    return null;
                }
            );

            if (firstCallbackId === null) firstCallbackId = callbackId;

            const invocation = callbackManager.getPendingCallback(callbackId);
            if (invocation) {
                invocation.enumerationState = {
                    continueEnumeration: processNext,
                    finishEnumeration: () => {}
                };
            }
        };

        processNext();

        return {
            value: 0,
            suspendedForCallback: true,
            callbackId: firstCallbackId || 0,
            stackCleanup: 12
        };
    };

    // IDirect3D7::CreateVertexBuffer(this, lpVBDesc, lplpVB, dwFlags)
    exports["IDirect3D7_CreateVertexBuffer"] = (ctx, mem, args) => {
        const lpDesc = args[1];
        const lplpVB = args[2];
        const dwFlags = args[3];

        if (!lpDesc || !lplpVB) return 0x80004003; // E_POINTER
        initReturnPtr(lplpVB);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const dwCaps = view.getUint32(lpDesc + 4, true);
        const dwFVF = view.getUint32(lpDesc + 8, true);
        const dwNumVertices = view.getUint32(lpDesc + 12, true);

        const vertexSize = computeFvfStride(dwFVF);
        const totalBytes = vertexSize * dwNumVertices;

        Logger.log(LogCategory.SYSTEM,
            `IDirect3D7_CreateVertexBuffer: caps=0x${dwCaps.toString(16)} fvf=0x${dwFVF.toString(16)} ` +
            `numVerts=${dwNumVertices} vertSize=${vertexSize} total=${totalBytes} flags=0x${dwFlags.toString(16)}`);

        // Allocate guest memory for vertex data
        const dataPtr = context.process.memory.alloc(totalBytes);
        if (!dataPtr) {
            Logger.error(LogCategory.SYSTEM, `IDirect3D7_CreateVertexBuffer: failed to alloc ${totalBytes} bytes`);
            return 0x8876017c; // DDERR_OUTOFMEMORY
        }

        const vtableAddr = context.vtables.IDirect3DVertexBuffer7?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.SYSTEM, `IDirect3D7_CreateVertexBuffer: no vtable for IDirect3DVertexBuffer7`);
            return 0x80004002;
        }

        const obj = ComObjectFactory.create(IID_IDirect3DVertexBuffer, vtableAddr) as Direct3DVertexBufferObject;
        if (!obj) return 0x80004005;

        obj.setBufferInfo(dataPtr, dwFVF, dwNumVertices, dwCaps, vertexSize);
        obj.setInterfaceVersion(7);

        if (!isValidAddress(mem, lplpVB, 4, "rw")) return 0x80004003;
        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        view.setUint32(lplpVB, objAddr, true);
        resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        Logger.log(LogCategory.SYSTEM,
            `IDirect3D7_CreateVertexBuffer -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)}, data=0x${dataPtr.toString(16)})`);
        return D3D_OK;
    };

    exports["IDirect3D7_EvictManagedTextures"] = () => D3D_OK;

    return exports;
};
