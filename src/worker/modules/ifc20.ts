/**
 * IFC20.dll — Immersion TouchSense force-feedback (stub implementation).
 *
 * HoMM3 imports CImmMouse, CImmProject, CImmDevice, CImmCompoundEffect.
 * Real hardware is never present in browser, so all methods return "no device"
 * or no-op. The critical requirement is that constructors write a valid vtable
 * pointer so virtual calls don't #PF through a NULL vtable.
 */

import { IModule } from '../core/module';
import { writeGuestCode } from '../core/memory/guest-code';
import { Process } from '../core/process';
import { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../core/logger';

// CImmMouse vtable method definitions (7 entries, all thiscall → stdcall with this as arg[0])
const MOUSE_VTABLE_METHODS = [
    { name: 'CImmMouse_dtor',            stackCleanupBytes: 4  }, // scalar_deleting_dtor(flags)
    { name: 'CImmMouse_GetAPI',           stackCleanupBytes: 0  }, // GetAPI()
    { name: 'CImmMouse_GetDevice',        stackCleanupBytes: 0  }, // GetDevice()
    { name: 'CImmMouse_ChangeScreenRes',  stackCleanupBytes: 12 }, // ChangeScreenResolution(w, h, bpp)
    { name: 'CImmMouse_SwitchToAbsMode',  stackCleanupBytes: 4  }, // SwitchToAbsoluteMode(flag)
    { name: 'CImmMouse_prepare_device',   stackCleanupBytes: 0  }, // prepare_device()
    { name: 'CImmMouse_reset',            stackCleanupBytes: 0  }, // reset()
];

const CIMMMOUSE_SIZE = 0x2C;   // 44 bytes
const CIMMPROJECT_SIZE = 0x10; // 16 bytes

export class IFC20 implements IModule {
    name = 'ifc20';
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private mouseVtableAddr = 0;

    initialize(process: Process): void {
        this.process = process;
        this.setupVtable(process);
        this.registerExports(process);
    }

    private setupVtable(process: Process): void {
        const tg = process.thunkGenerator;
        const mem = process.getCurrentMemory();
        if (!tg || !mem) return;

        // Generate thunk stubs for vtable methods
        const stubDll = tg.generateStubDll(
            'ifc20_vtable',
            MOUSE_VTABLE_METHODS.map(m => ({
                name: m.name,
                stackCleanupBytes: m.stackCleanupBytes,
                callingConvention: 'stdcall',
            }))
        );

        // Write stub code to guest memory
        writeGuestCode(mem, stubDll.stubCode, stubDll.baseAddress);

        // Allocate vtable array (7 entries × 4 bytes = 28 bytes)
        this.mouseVtableAddr = tg.allocateVTableMemory(MOUSE_VTABLE_METHODS.length * 4);
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Fill vtable with stub addresses
        for (let i = 0; i < MOUSE_VTABLE_METHODS.length; i++) {
            const addr = stubDll.exportTable.get(MOUSE_VTABLE_METHODS[i].name.toLowerCase());
            if (addr !== undefined) {
                dv.setUint32(this.mouseVtableAddr + i * 4, addr, true);
            }
        }

        // Register no-op implementations for all vtable methods
        for (const m of MOUSE_VTABLE_METHODS) {
            process.dispatcher.register('ifc20_vtable', m.name, () => 0);
        }

        Logger.info(LogCategory.SYSTEM, `IFC20: CImmMouse vtable at 0x${this.mouseVtableAddr.toString(16)} (${MOUSE_VTABLE_METHODS.length} entries)`);
    }

    private registerExports(_process: Process): void {
        const self = this;

        // ---- CImmMouse ----

        // CImmMouse::CImmMouse() — thiscall, 0 extra args, RET 0
        this.exports['??0CImmMouse@@QAE@XZ'] = (ctx, mem, _args) => {
            const thisPtr = ctx.ecx; // thiscall: this in ECX
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // Write vtable pointer
            dv.setUint32(thisPtr, self.mouseVtableAddr, true);
            // Zero remaining fields
            for (let i = 4; i < CIMMMOUSE_SIZE; i += 4) {
                dv.setUint32(thisPtr + i, 0, true);
            }
            // deviceType = 2 (mouse)
            dv.setUint32(thisPtr + 0x0C, 2, true);
            Logger.verbose(LogCategory.SYSTEM, `IFC20: CImmMouse ctor this=0x${thisPtr.toString(16)}`);
            return thisPtr;
        };

        // CImmMouse::~CImmMouse() — thiscall, 0 extra args
        this.exports['??1CImmMouse@@UAE@XZ'] = (_ctx, _mem, _args) => 0;

        // CImmMouse::Initialize(hWnd, hInst, flags) — thiscall, 3 args (12 bytes on stack)
        // Returns 0 = no FF hardware
        this.exports['?Initialize@CImmMouse@@QAEHPAX0K@Z'] = (_ctx, _mem, _args) => {
            Logger.verbose(LogCategory.SYSTEM, 'IFC20: CImmMouse::Initialize → 0 (no FF hardware)');
            return 0;
        };

        // CImmMouse::HaveImmMouse() — returns 0 (no device)
        this.exports['?HaveImmMouse@CImmMouse@@QAEHXZ'] = () => 0;

        // CImmMouse::Shutdown() — void no-op
        this.exports['?Shutdown@CImmMouse@@QAEXXZ'] = () => 0;

        // ---- CImmDevice ----

        // CImmDevice::CImmDevice() — thiscall constructor
        this.exports['??0CImmDevice@@QAE@XZ'] = (ctx, mem, _args) => {
            const thisPtr = ctx.ecx;
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // CImmDevice is 0x24 bytes; zero it and write vtable
            // Uses same vtable shape as mouse (base class) — ok for stub
            dv.setUint32(thisPtr, self.mouseVtableAddr, true);
            for (let i = 4; i < 0x24; i += 4) {
                dv.setUint32(thisPtr + i, 0, true);
            }
            return thisPtr;
        };

        // CImmDevice::~CImmDevice()
        this.exports['??1CImmDevice@@UAE@XZ'] = () => 0;

        // CImmDevice::CreateDevice(hInstance, hWnd) — static, returns NULL (no device)
        this.exports['?CreateDevice@CImmDevice@@SAPAV1@PAUHINSTANCE__@@PAUHWND__@@@Z'] = () => 0;

        // ---- CImmProject ----

        // CImmProject::CImmProject() — thiscall constructor (no vtable, 0x10 bytes)
        this.exports['??0CImmProject@@QAE@XZ'] = (ctx, mem, _args) => {
            const thisPtr = ctx.ecx;
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < CIMMPROJECT_SIZE; i += 4) {
                dv.setUint32(thisPtr + i, 0, true);
            }
            return thisPtr;
        };

        // CImmProject::~CImmProject()
        this.exports['??1CImmProject@@QAE@XZ'] = () => 0;

        // CImmProject::LoadProjectFromMemory(data, device) — returns 0 (failure)
        this.exports['?LoadProjectFromMemory@CImmProject@@QAEHPAXPAVCImmDevice@@@Z'] = () => 0;

        // CImmProject::DestroyEffect(effect) — void no-op
        this.exports['?DestroyEffect@CImmProject@@QAEXPAVCImmCompoundEffect@@@Z'] = () => 0;

        // CImmProject::Close() — void no-op
        this.exports['?Close@CImmProject@@QAEXXZ'] = () => 0;

        // ---- CImmCompoundEffect ----

        // CImmCompoundEffect::CImmCompoundEffect()
        this.exports['??0CImmCompoundEffect@@QAE@XZ'] = (ctx, mem, _args) => {
            const thisPtr = ctx.ecx;
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < 0x10; i += 4) {
                dv.setUint32(thisPtr + i, 0, true);
            }
            return thisPtr;
        };

        // CImmCompoundEffect::~CImmCompoundEffect()
        this.exports['??1CImmCompoundEffect@@QAE@XZ'] = () => 0;
    }

    reset(): void {
        this.mouseVtableAddr = 0;
    }

    recreateVTables(): void {
        if (this.process) this.setupVtable(this.process);
    }
}
