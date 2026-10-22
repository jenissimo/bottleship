import { afterEach, beforeEach, expect, test } from 'bun:test';
import { RegistryStore } from '../../src/worker/runtime/filesystem/registry';
import { System } from '../../src/worker/core/system';
import { installDirectPlayRegistration } from '../../src/worker/modules/directplay-registration';
import type { ThunkImplementation, X86Context } from '../../src/worker/core/thunking/thunk-dispatcher';

const system = System.getInstance(), savedRegistry = system.registry;
const clsid = 'CLSID\\{743F1DC6-5ABA-429F-8BDF-C54D03253DC2}';
let registry: RegistryStore, methods: Record<string, ThunkImplementation>;
const call = (name: string) => methods[name]({} as X86Context, new Uint8Array(), []);
const value = (root: string, path: string, name = '') => {
    const key = registry.open(root, path); return key ? registry.getValue(key, name)?.data : undefined;
};
beforeEach(() => { registry = new RegistryStore(); system.registry = registry; methods = {}; installDirectPlayRegistration(methods, 'dpnet'); });
afterEach(() => { system.registry = savedRegistry; });

test('DP8 registers versioned and independent COM names and the native threading model', () => {
    expect(call('DllRegisterServer')).toBe(0);
    expect(value('hkcr', clsid)).toBe('DirectPlay8Client Object');
    expect(value('hkcr', clsid + '\\InprocServer32')).toBe('dpnet.dll');
    expect(value('hkcr', clsid + '\\InprocServer32', 'ThreadingModel')).toBe('Both');
    expect(value('hkcr', clsid + '\\ProgID')).toBe('DirectPlay8.Client.1');
    expect(value('hkcr', 'DirectPlay8.Client\\CurVer')).toBe('DirectPlay8.Client.1');
    expect(value('hkcr', 'DirectPlay8.Client.1\\CLSID')).toBe('{743F1DC6-5ABA-429F-8BDF-C54D03253DC2}');
    expect(registry.open('hklm', 'Software\\Microsoft\\DirectPlay8\\Service Providers')).not.toBeNull();
    expect(call('DllRegisterServer')).toBe(0);
    expect(call('DllUnregisterServer')).toBe(0);
    expect(registry.open('hkcr', clsid)).toBeNull();
    expect(registry.open('hkcr', 'DirectPlay8.Client')).toBeNull();
    expect(registry.open('hkcr', 'DirectPlay8.Client.1')).toBeNull();
    expect(call('DllUnregisterServer')).toBe(0x80004005);
});
test('unregister preserves third-party provider and ProgID children instead of recursively deleting them', () => {
    call('DllRegisterServer');
    registry.createKey('hklm', 'Software\\Microsoft\\DirectPlay8\\Service Providers\\ThirdParty');
    const { key } = registry.createKey('hkcr', 'DirectPlay8.Client.1\\Foreign');
    registry.setValue(key, 'owner', { name: 'owner', type: 'REG_SZ', data: 'game' });
    expect(call('DllUnregisterServer')).toBe(0x80004005);
    expect(value('hkcr', 'DirectPlay8.Client.1\\Foreign', 'owner')).toBe('game');
    expect(registry.open('hkcr', clsid)).not.toBeNull();
    expect(registry.open('hkcr', 'DirectPlay8.Server')).toBeNull();
    expect(registry.open('hkcr', 'DirectPlay8.Peer')).toBeNull();
    expect(registry.open('hklm', 'Software\\Microsoft\\DirectPlay8\\Service Providers\\ThirdParty')).not.toBeNull();
});
test('classic unregister leaves application registrations available to Lobby', () => {
    installDirectPlayRegistration(methods, 'dplayx');
    expect(call('DllRegisterServer')).toBe(0);
    const path = 'Software\\Microsoft\\DirectPlay\\Applications\\Example';
    const { key } = registry.createKey('hklm', path);
    registry.setValue(key, 'Path', { name: 'Path', type: 'REG_SZ', data: 'C:\\Games\\Example' });
    expect(call('DllUnregisterServer')).toBe(0);
    expect(value('hklm', path, 'Path')).toBe('C:\\Games\\Example');
});

test('DP8 lobby registers both classes in its own DLL and removes an empty application catalog', () => {
    installDirectPlayRegistration(methods, 'dpnlobby');
    expect(call('DllRegisterServer')).toBe(0);
    for (const [guid, progId, description] of [
        ['3B2B6775-70B6-45AF-8DEA-A209C69559F3', 'DirectPlay8Lobby.LobbyClient', 'DirectPlay8LobbyClient Object'],
        ['667955AD-6B3B-43CA-B949-BC69B5BAFF7F', 'DirectPlay8Lobby.LobbiedApplication', 'DirectPlay8LobbiedApplication Object'],
    ]) {
        const base = 'CLSID\\{' + guid + '}';
        expect(value('hkcr', base)).toBe(description);
        expect(value('hkcr', base + '\\InprocServer32')).toBe('dpnlobby.dll');
        expect(value('hkcr', base + '\\InprocServer32', 'ThreadingModel')).toBe('Both');
        expect(value('hkcr', base + '\\ProgID')).toBe(progId + '.1');
        expect(value('hkcr', progId + '\\CurVer')).toBe(progId + '.1');
        expect(value('hkcr', progId + '.1\\CLSID')).toBe('{' + guid + '}');
    }
    const applications = 'Software\\Microsoft\\DirectPlay8\\Applications';
    expect(registry.open('hklm', applications)).not.toBeNull();
    expect(call('DllUnregisterServer')).toBe(0);
    expect(registry.open('hklm', applications)).toBeNull();
    expect(registry.open('hkcr', 'DirectPlay8Lobby.LobbyClient')).toBeNull();
    expect(registry.open('hkcr', 'DirectPlay8Lobby.LobbiedApplication.1')).toBeNull();
});
test('DP8 lobby unregister preserves registered applications and unrelated DP8 network classes', () => {
    call('DllRegisterServer');
    installDirectPlayRegistration(methods, 'dpnlobby');
    call('DllRegisterServer');
    const path = 'Software\\Microsoft\\DirectPlay8\\Applications\\Example';
    const { key } = registry.createKey('hklm', path);
    registry.setValue(key, 'Path', { name: 'Path', type: 'REG_SZ', data: 'C:\\Games\\Example' });
    expect(call('DllUnregisterServer')).toBe(0);
    expect(value('hklm', path, 'Path')).toBe('C:\\Games\\Example');
    expect(value('hkcr', clsid + '\\InprocServer32')).toBe('dpnet.dll');
    expect(registry.open('hklm', 'Software\\Microsoft\\DirectPlay8\\Service Providers')).not.toBeNull();
});
