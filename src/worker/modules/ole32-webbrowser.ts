import type { Process } from '../core/process';
import type { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { installComVtable } from '../core/com/install-com-vtable';
import { allocateComObject, freeComObject } from '../core/com/com-memory';
import { readGuidFromMem } from '../core/com/typelib/typelib-types';
import { Mem } from '../core/memory/mem-accessor';

export const CLSID_WEBBROWSER = '8856f961-340a-11d0-a96b-00c04fd705a2';
const CLSID_BYTES = [0x61, 0xf9, 0x56, 0x88, 0x0a, 0x34, 0xd0, 0x11, 0xa9, 0x6b, 0x00, 0xc0, 0x4f, 0xd7, 0x05, 0xa2];

const IID_IUNKNOWN = '00000000-0000-0000-c000-000000000046';
const IID_IOLEOBJECT = '00000112-0000-0000-c000-000000000046';
const IID_IOLEINPLACEOBJECT = '00000113-0000-0000-c000-000000000046';
const IID_IOLEWINDOW = '00000114-0000-0000-c000-000000000046';
const IID_IOLECONTROL = 'b196b288-bab4-101a-b69c-00aa00341d07';
const IID_IPERSIST = '0000010c-0000-0000-c000-000000000046';
const IID_IPERSISTSTREAMINIT = '7fd52380-4e07-101b-ae2d-08002b2ec713';
const IID_IDISPATCH = '00020400-0000-0000-c000-000000000046';
const IID_IWEBBROWSER = 'eab22ac1-30c1-11cf-a7eb-0000c05bae0b';
const IID_IWEBBROWSERAPP = '0002df05-0000-0000-c000-000000000046';
const IID_IWEBBROWSER2 = 'd30c1661-cdaf-11d0-8a3e-00c04fc9e26e';

const S_OK = 0, S_FALSE = 1;
const E_NOTIMPL = 0x80004001, E_NOINTERFACE = 0x80004002, E_POINTER = 0x80004003, E_FAIL = 0x80004005;
const DISP_E_UNKNOWNNAME = 0x80020006;
const OLEOBJ_E_NOVERBS = 0x80040180;
const OLEMISC_INVISIBLEATRUNTIME = 0x400;
const READYSTATE_COMPLETE = 4;

type Face = 'object' | 'inplace' | 'control' | 'persist' | 'browser';
const FACE_OF: Record<string, Face> = {
    [IID_IUNKNOWN]: 'object', [IID_IOLEOBJECT]: 'object',
    [IID_IOLEINPLACEOBJECT]: 'inplace', [IID_IOLEWINDOW]: 'inplace',
    [IID_IOLECONTROL]: 'control',
    [IID_IPERSIST]: 'persist', [IID_IPERSISTSTREAMINIT]: 'persist',
    [IID_IDISPATCH]: 'browser', [IID_IWEBBROWSER]: 'browser', [IID_IWEBBROWSERAPP]: 'browser', [IID_IWEBBROWSER2]: 'browser',
};

const UNKNOWN_METHODS: [string, number][] = [['QueryInterface', 3], ['AddRef', 1], ['Release', 1]];
const DISPATCH_METHODS: [string, number][] = [['GetTypeInfoCount', 2], ['GetTypeInfo', 4], ['GetIDsOfNames', 6], ['Invoke', 9]];
export const WEBBROWSER_LAYOUTS: Record<Face, [string, number][]> = {
    object: [...UNKNOWN_METHODS,
        ['SetClientSite', 2], ['GetClientSite', 2], ['SetHostNames', 3], ['Close', 2], ['SetMoniker', 3], ['GetMoniker', 4],
        ['InitFromData', 4], ['GetClipboardData', 3], ['DoVerb', 7], ['EnumVerbs', 2], ['Update', 1], ['IsUpToDate', 1],
        ['GetUserClassID', 2], ['GetUserType', 3], ['SetExtent', 3], ['GetExtent', 3], ['Advise', 3], ['Unadvise', 2],
        ['EnumAdvise', 2], ['GetMiscStatus', 3], ['SetColorScheme', 2]],
    inplace: [...UNKNOWN_METHODS,
        ['GetWindow', 2], ['ContextSensitiveHelp', 2], ['InPlaceDeactivate', 1], ['UIDeactivate', 1], ['SetObjectRects', 3],
        ['ReactivateAndUndo', 1]],
    control: [...UNKNOWN_METHODS,
        ['GetControlInfo', 2], ['OnMnemonic', 2], ['OnAmbientPropertyChange', 2], ['FreezeEvents', 2]],
    persist: [...UNKNOWN_METHODS,
        ['GetClassID', 2], ['IsDirty', 1], ['Load', 2], ['Save', 3], ['GetSizeMax', 2], ['InitNew', 1]],
    browser: [...UNKNOWN_METHODS, ...DISPATCH_METHODS,
        ['GoBack', 1], ['GoForward', 1], ['GoHome', 1], ['GoSearch', 1], ['Navigate', 6], ['Refresh', 1], ['Refresh2', 2],
        ['Stop', 1], ['get_Application', 2], ['get_Parent', 2], ['get_Container', 2], ['get_Document', 2],
        ['get_TopLevelContainer', 2], ['get_Type', 2], ['get_Left', 2], ['put_Left', 2], ['get_Top', 2], ['put_Top', 2],
        ['get_Width', 2], ['put_Width', 2], ['get_Height', 2], ['put_Height', 2], ['get_LocationName', 2],
        ['get_LocationURL', 2], ['get_Busy', 2],
        ['Quit', 1], ['ClientToWindow', 3], ['PutProperty', 6], ['GetProperty', 3], ['get_Name', 2], ['get_HWND', 2],
        ['get_FullName', 2], ['get_Path', 2], ['get_Visible', 2], ['put_Visible', 2], ['get_StatusBar', 2],
        ['put_StatusBar', 2], ['get_StatusText', 2], ['put_StatusText', 2], ['get_ToolBar', 2], ['put_ToolBar', 2],
        ['get_MenuBar', 2], ['put_MenuBar', 2], ['get_FullScreen', 2], ['put_FullScreen', 2],
        ['Navigate2', 6], ['QueryStatusWB', 3], ['ExecWB', 5], ['ShowBrowserBar', 4], ['get_ReadyState', 2],
        ['get_Offline', 2], ['put_Offline', 2], ['get_Silent', 2], ['put_Silent', 2], ['get_RegisterAsBrowser', 2],
        ['put_RegisterAsBrowser', 2], ['get_RegisterAsDropTarget', 2], ['put_RegisterAsDropTarget', 2],
        ['get_TheaterMode', 2], ['put_TheaterMode', 2], ['get_AddressBar', 2], ['put_AddressBar', 2],
        ['get_Resizable', 2], ['put_Resizable', 2]],
};

interface Instance { faces: Record<Face, number>; refs: number; site: number; left: number; top: number; width: number; height: number }
interface Runtime { generation: number; vtables: Record<Face, number>; instances: Map<number, Instance> }
// @transient(the WebBrowser stand-in has no state worth restoring: a reloaded game re-creates its control, and a resetGeneration change discards the tables)
const runtimes = new WeakMap<Process, Runtime>();

const FACES: Face[] = ['object', 'inplace', 'control', 'persist', 'browser'];
const PREFIX: Record<Face, string> = {
    object: 'WebBrowser_IOleObject', inplace: 'WebBrowser_IOleInPlaceObject', control: 'WebBrowser_IOleControl',
    persist: 'WebBrowser_IPersistStreamInit', browser: 'WebBrowser_IWebBrowser2',
};

function out32(p: number, v: number): boolean { return p !== 0 && Mem.writeUint32(p, v >>> 0); }
function zero(p: number, n: number): boolean {
    if (!p) return false;
    for (let i = 0; i < n; i += 4) if (!Mem.writeUint32(p + i, 0)) return false;
    return true;
}

function runtime(process: Process): Runtime | null {
    const cached = runtimes.get(process);
    if (cached?.generation === process.resetGeneration) return cached;
    runtimes.delete(process);
    const r: Runtime = { generation: process.resetGeneration, vtables: { object: 0, inplace: 0, control: 0, persist: 0, browser: 0 }, instances: new Map() };
    const release = (o: Instance) => {
        if (--o.refs > 0) return o.refs;
        for (const face of FACES) { r.instances.delete(o.faces[face]); freeComObject(process.memory, o.faces[face]); }
        o.refs = 0;
        return 0;
    };
    const getter = (value: (o: Instance) => number): ThunkImplementation => (_c, _m, a) => {
        const o = r.instances.get(a[0] >>> 0);
        if (!o) return E_POINTER;
        return out32(a[1] >>> 0, value(o)) ? S_OK : E_POINTER;
    };
    const ok: ThunkImplementation = () => S_OK;
    const handlers: Record<string, ThunkImplementation> = {};
    for (const face of FACES) {
        const p = PREFIX[face];
        handlers[`${p}_QueryInterface`] = (_c, mem, a) => {
            const o = r.instances.get(a[0] >>> 0);
            if (!o) return E_POINTER;
            const outp = a[2] >>> 0;
            if (!out32(outp, 0)) return E_POINTER;
            if (!a[1] || (a[1] >>> 0) + 16 > mem.length) return E_POINTER;
            const target = FACE_OF[readGuidFromMem(mem, a[1] >>> 0).toLowerCase()];
            if (!target) return E_NOINTERFACE;
            if (!out32(outp, o.faces[target])) return E_POINTER;
            o.refs++;
            return S_OK;
        };
        handlers[`${p}_AddRef`] = (_c, _m, a) => { const o = r.instances.get(a[0] >>> 0); return o ? ++o.refs : 0; };
        handlers[`${p}_Release`] = (_c, _m, a) => { const o = r.instances.get(a[0] >>> 0); return o ? release(o) : 0; };
    }
    const O = PREFIX.object;
    Object.assign(handlers, {
        [`${O}_SetClientSite`]: ((_c, _m, a) => { const o = r.instances.get(a[0] >>> 0); if (o) o.site = a[1] >>> 0; return S_OK; }) as ThunkImplementation,
        [`${O}_GetClientSite`]: ((_c, _m, a) => out32(a[1] >>> 0, 0) ? E_FAIL : E_POINTER) as ThunkImplementation,
        [`${O}_SetHostNames`]: ok, [`${O}_Close`]: ok, [`${O}_SetMoniker`]: ok,
        [`${O}_GetMoniker`]: ((_c, _m, a) => { out32(a[3] >>> 0, 0); return E_NOTIMPL; }) as ThunkImplementation,
        [`${O}_InitFromData`]: (() => E_NOTIMPL) as ThunkImplementation,
        [`${O}_GetClipboardData`]: ((_c, _m, a) => { out32(a[2] >>> 0, 0); return E_NOTIMPL; }) as ThunkImplementation,
        [`${O}_DoVerb`]: ok,
        [`${O}_EnumVerbs`]: ((_c, _m, a) => { out32(a[1] >>> 0, 0); return OLEOBJ_E_NOVERBS; }) as ThunkImplementation,
        [`${O}_Update`]: ok, [`${O}_IsUpToDate`]: ok,
        [`${O}_GetUserClassID`]: ((_c, _m, a) => writeClsid(a[1] >>> 0)) as ThunkImplementation,
        [`${O}_GetUserType`]: ((_c, _m, a) => { out32(a[2] >>> 0, 0); return E_NOTIMPL; }) as ThunkImplementation,
        [`${O}_SetExtent`]: ok,
        [`${O}_GetExtent`]: ((_c, _m, a) => zero(a[2] >>> 0, 8) ? S_OK : E_POINTER) as ThunkImplementation,
        [`${O}_Advise`]: ((_c, _m, a) => out32(a[2] >>> 0, 1) ? S_OK : E_POINTER) as ThunkImplementation,
        [`${O}_Unadvise`]: ok,
        [`${O}_EnumAdvise`]: ((_c, _m, a) => { out32(a[1] >>> 0, 0); return E_NOTIMPL; }) as ThunkImplementation,
        [`${O}_GetMiscStatus`]: ((_c, _m, a) => out32(a[2] >>> 0, OLEMISC_INVISIBLEATRUNTIME) ? S_OK : E_POINTER) as ThunkImplementation,
        [`${O}_SetColorScheme`]: ok,
    });
    const I = PREFIX.inplace;
    Object.assign(handlers, {
        [`${I}_GetWindow`]: ((_c, _m, a) => { out32(a[1] >>> 0, 0); return E_FAIL; }) as ThunkImplementation,
        [`${I}_ContextSensitiveHelp`]: ok, [`${I}_InPlaceDeactivate`]: ok, [`${I}_UIDeactivate`]: ok,
        [`${I}_SetObjectRects`]: ok, [`${I}_ReactivateAndUndo`]: ok,
    });
    const C = PREFIX.control;
    Object.assign(handlers, {
        [`${C}_GetControlInfo`]: ((_c, _m, a) => {
            const p = a[1] >>> 0;
            return p && Mem.writeUint32(p + 4, 0) && Mem.writeUint32(p + 8, 0) && Mem.writeUint32(p + 12, 0) ? S_OK : E_POINTER;
        }) as ThunkImplementation,
        [`${C}_OnMnemonic`]: ok, [`${C}_OnAmbientPropertyChange`]: ok, [`${C}_FreezeEvents`]: ok,
    });
    const P = PREFIX.persist;
    Object.assign(handlers, {
        [`${P}_GetClassID`]: ((_c, _m, a) => writeClsid(a[1] >>> 0)) as ThunkImplementation,
        [`${P}_IsDirty`]: (() => S_FALSE) as ThunkImplementation,
        [`${P}_Load`]: ok, [`${P}_Save`]: ok,
        [`${P}_GetSizeMax`]: ((_c, _m, a) => zero(a[1] >>> 0, 8) ? S_OK : E_POINTER) as ThunkImplementation,
        [`${P}_InitNew`]: ok,
    });
    const B = PREFIX.browser;
    const zeroGetters = ['get_Application', 'get_Parent', 'get_Container', 'get_Document', 'get_TopLevelContainer', 'get_Type',
        'get_LocationName', 'get_LocationURL', 'get_Busy', 'get_Name', 'get_HWND', 'get_FullName', 'get_Path', 'get_Visible',
        'get_StatusBar', 'get_StatusText', 'get_ToolBar', 'get_MenuBar', 'get_FullScreen', 'get_Offline', 'get_Silent',
        'get_RegisterAsBrowser', 'get_RegisterAsDropTarget', 'get_TheaterMode', 'get_AddressBar', 'get_Resizable'];
    for (const name of zeroGetters) handlers[`${B}_${name}`] = getter(() => 0);
    handlers[`${B}_get_ReadyState`] = getter(() => READYSTATE_COMPLETE);
    handlers[`${B}_get_Left`] = getter(o => o.left);
    handlers[`${B}_get_Top`] = getter(o => o.top);
    handlers[`${B}_get_Width`] = getter(o => o.width);
    handlers[`${B}_get_Height`] = getter(o => o.height);
    const setter = (key: 'left' | 'top' | 'width' | 'height'): ThunkImplementation => (_c, _m, a) => {
        const o = r.instances.get(a[0] >>> 0);
        if (o) o[key] = a[1] | 0;
        return o ? S_OK : E_POINTER;
    };
    handlers[`${B}_put_Left`] = setter('left'); handlers[`${B}_put_Top`] = setter('top');
    handlers[`${B}_put_Width`] = setter('width'); handlers[`${B}_put_Height`] = setter('height');
    for (const name of ['GoBack', 'GoForward', 'GoHome', 'GoSearch', 'Navigate', 'Refresh', 'Refresh2', 'Stop', 'Quit',
        'PutProperty', 'put_Visible', 'put_StatusBar', 'put_StatusText', 'put_ToolBar', 'put_MenuBar', 'put_FullScreen',
        'Navigate2', 'ExecWB', 'ShowBrowserBar', 'put_Offline', 'put_Silent', 'put_RegisterAsBrowser',
        'put_RegisterAsDropTarget', 'put_TheaterMode', 'put_AddressBar', 'put_Resizable', 'ClientToWindow'])
        handlers[`${B}_${name}`] = ok;
    handlers[`${B}_GetProperty`] = (_c, _m, a) => zero(a[2] >>> 0, 16) ? S_OK : E_POINTER;
    handlers[`${B}_QueryStatusWB`] = (_c, _m, a) => out32(a[2] >>> 0, 0) ? S_OK : E_POINTER;
    handlers[`${B}_GetTypeInfoCount`] = (_c, _m, a) => out32(a[1] >>> 0, 0) ? S_OK : E_POINTER;
    handlers[`${B}_GetTypeInfo`] = (_c, _m, a) => { out32(a[3] >>> 0, 0); return E_NOTIMPL; };
    handlers[`${B}_GetIDsOfNames`] = (_c, _m, a) => {
        const ids = a[5] >>> 0, count = a[3] >>> 0;
        for (let i = 0; i < count && ids; i++) Mem.writeUint32(ids + i * 4, 0xffffffff);
        return DISP_E_UNKNOWNNAME;
    };
    handlers[`${B}_Invoke`] = (_c, _m, a) => {
        const result = a[6] >>> 0;
        if (result) zero(result, 16);
        return S_OK;
    };
    for (const face of FACES) {
        const prefix = PREFIX[face];
        const installed = installComVtable(process, {
            moduleName: 'webbrowser', handlers,
            methods: WEBBROWSER_LAYOUTS[face].map(([name, count]) => ({ name: `${prefix}_${name}`, argCount: count, stackCleanupBytes: count * 4 })),
            logLabel: prefix,
        });
        if (!installed) return null;
        r.vtables[face] = installed.vtableAddr;
    }
    runtimes.set(process, r);
    return r;
}

function writeClsid(p: number): number {
    if (!p) return E_POINTER;
    for (let i = 0; i < 16; i++) if (!Mem.writeUint8(p + i, CLSID_BYTES[i])) return E_POINTER;
    return S_OK;
}

export function coCreateWebBrowser(process: Process, clsid: string, iid: string, out: number): number | null {
    if (clsid !== CLSID_WEBBROWSER) return null;
    const mem = process.getCurrentMemory();
    if (!out || out + 4 > mem.length) return E_POINTER;
    Mem.writeUint32(out, 0);
    const face = FACE_OF[iid];
    if (!face) return E_NOINTERFACE;
    const r = runtime(process);
    if (!r) return E_FAIL;
    const faces = {} as Record<Face, number>;
    for (const f of FACES) faces[f] = allocateComObject(process.memory, process.getCurrentMemory(), r.vtables[f]);
    const object: Instance = { faces, refs: 1, site: 0, left: 0, top: 0, width: 0, height: 0 };
    for (const f of FACES) r.instances.set(faces[f], object);
    if (!Mem.writeUint32(out, faces[face])) {
        for (const f of FACES) { r.instances.delete(faces[f]); freeComObject(process.memory, faces[f]); }
        return E_POINTER;
    }
    return S_OK;
}
