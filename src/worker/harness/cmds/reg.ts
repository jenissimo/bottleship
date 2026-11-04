/**
 * Registry read/patch harness verbs — the lever for resolution-apply /
 * EnumDisplayModes bring-up blockers. Wraps
 * System.registry (RegistryStore). open() returns a normalized string keyHandle,
 * threaded into getValue/enumValues/enumSubKeys.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";

function reg(): any {
    const r = sys().registry;
    if (!r) throw new HarnessError("no registry", HarnessErrorCode.NO_PROCESS);
    return r as any;
}

export function registerRegistryCommands(svc: HarnessService): void {
    /** regGet(root, key, value?) — one value, or all values when value omitted. */
    svc.register("regGet", (args) => {
        const root = String(args[0] ?? "");
        const key = String(args[1] ?? "");
        // The RPC is JSON, so an omitted value arrives as null, not undefined.
        const value = args[2] as string | null | undefined;
        const r = reg();
        const kh = r.open(root, key);
        if (!kh) throw new HarnessError(`registry key not found: ${root}\\${key}`, HarnessErrorCode.NOT_FOUND);
        if (value != null) return { key: kh, value: r.getValue(kh, value) };
        return { key: kh, values: r.enumValues(kh) };
    });

    /** regSet(root, key, name, data, type?) — write a value (type inferred from data if omitted). */
    svc.register("regSet", (args) => {
        const root = String(args[0] ?? "");
        const key = String(args[1] ?? "");
        const name = String(args[2] ?? "");
        const data = args[3] as string | number;
        const type = (args[4] as string | undefined) ?? (typeof data === "number" ? "REG_DWORD" : "REG_SZ");
        const r = reg();
        const created = r.createKey(root, key);
        const kh = created?.key ?? r.open(root, key);
        if (!kh) throw new HarnessError(`cannot open/create ${root}\\${key}`, HarnessErrorCode.INTERNAL);
        r.setValue(kh, name, { name, type, data });
        return { key: kh, name, type, data, createdKey: created?.isNew ?? false };
    });

    /** regEnum(root, key) — subkeys + values under a key. */
    svc.register("regEnum", (args) => {
        const root = String(args[0] ?? "");
        const key = String(args[1] ?? "");
        const r = reg();
        const kh = r.open(root, key);
        if (!kh) throw new HarnessError(`registry key not found: ${root}\\${key}`, HarnessErrorCode.NOT_FOUND);
        return { key: kh, subKeys: r.enumSubKeys(kh) ?? [], values: r.enumValues(kh) ?? [] };
    });
}
