import type { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import type { RegistryStore } from '../runtime/filesystem/registry';
import { System } from '../core/system';

const networkProfiles = [
    ['743f1dc6-5aba-429f-8bdf-c54d03253dc2', 'DirectPlay8.Client', 'DirectPlay8Client Object'],
    ['da825e1b-6830-43d7-835d-0b5ad82956a2', 'DirectPlay8.Server', 'DirectPlay8Server Object'],
    ['286f484d-375e-4458-a272-b138e2f80a6a', 'DirectPlay8.Peer', 'DirectPlay8Peer Object'],
] as const;
const lobbyProfiles = [
    ['3b2b6775-70b6-45af-8dea-a209c69559f3', 'DirectPlay8Lobby.LobbyClient', 'DirectPlay8LobbyClient Object'],
    ['667955ad-6b3b-43ca-b949-bc69b5baff7f', 'DirectPlay8Lobby.LobbiedApplication', 'DirectPlay8LobbiedApplication Object'],
] as const;
const providerRoot = 'Software\\Microsoft\\DirectPlay8';
const E_FAIL = 0x80004005;
function put(registry: RegistryStore, path: string, data: string, name = ''): void {
    const { key } = registry.createKey('hkcr', path);
    registry.setValue(key, name, { name, type: 'REG_SZ', data });
}
/** RegDeleteKey's leaf semantics, rather than RegistryStore's recursive tree removal. */
function removeLeaf(registry: RegistryStore, root: string, path: string): boolean {
    const key = registry.open(root, path);
    return !!key && registry.enumSubKeys(key).length === 0 && registry.deleteKey(key);
}
function unregisterClass(registry: RegistryStore, clsid: string): boolean {
    const base = 'CLSID\\{' + clsid.toUpperCase() + '}';
    const prog = registry.open('hkcr', base + '\\ProgID');
    if (!prog) return false;
    const versioned = registry.getValue(prog, '')?.data;
    if (typeof versioned === 'string') {
        if (!removeLeaf(registry, 'hkcr', versioned + '\\CLSID') || !removeLeaf(registry, 'hkcr', versioned)) return false;
    }
    const independent = registry.open('hkcr', base + '\\VersionIndependentProgID');
    if (!independent) return false;
    const unversioned = registry.getValue(independent, '')?.data;
    if (typeof unversioned === 'string') {
        for (const path of [unversioned + '\\CLSID', unversioned + '\\CurVer', unversioned]) {
            if (!removeLeaf(registry, 'hkcr', path)) return false;
        }
    }
    for (const path of [base + '\\InprocServer32', base + '\\ProgID', base + '\\VersionIndependentProgID', base]) {
        if (!removeLeaf(registry, 'hkcr', path)) return false;
    }
    return true;
}
/** NT5 DirectPlay DLL registration changes the guest registry only. */
export function installDirectPlayRegistration(exports: Record<string, ThunkImplementation>, module: 'dplayx' | 'dpnet' | 'dpnlobby'): void {
    const profiles = module === 'dpnlobby' ? lobbyProfiles : networkProfiles;
    const providerPath = providerRoot + (module === 'dpnlobby' ? '\\Applications' : '\\Service Providers');
    exports.DllRegisterServer = () => {
        const registry = System.getInstance().registry;
        if (module === 'dplayx') {
            registry.createKey('hklm', 'Software\\Microsoft\\DirectPlay\\Applications');
            return 0;
        }
        for (const [clsid, progId, description] of profiles) {
            const guid = '{' + clsid.toUpperCase() + '}', base = 'CLSID\\' + guid, versioned = progId + '.1';
            put(registry, base, description);
            put(registry, base + '\\InprocServer32', module + '.dll');
            put(registry, base + '\\InprocServer32', 'Both', 'ThreadingModel');
            put(registry, base + '\\VersionIndependentProgID', progId);
            put(registry, base + '\\ProgID', versioned);
            put(registry, progId, description); put(registry, progId + '\\CLSID', guid); put(registry, progId + '\\CurVer', versioned);
            put(registry, versioned, description); put(registry, versioned + '\\CLSID', guid);
        }
        registry.createKey('hklm', providerRoot); registry.createKey('hklm', providerPath);
        return 0;
    };
    exports.DllUnregisterServer = () => {
        if (module === 'dplayx') return 0; // Native leaves application registrations intact.
        const registry = System.getInstance().registry;
        let failed = false;
        for (const [clsid] of profiles) if (!unregisterClass(registry, clsid)) failed = true;
        registry.createKey('hklm', providerRoot);
        removeLeaf(registry, 'hklm', providerPath); // Native preserves installed applications and providers.
        return failed ? E_FAIL : 0;
    };
}
