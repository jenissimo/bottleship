/**
 * Unity 4/5 players import dnsapi!DnsQuery_A/DnsFree and winhttp!WinHttpGetIEProxyConfigForCurrentUser.
 * With no arity for them the PE load failed before the game started ("Stub requires argCount").
 * A declared stub must pop the right stack and answer with a value the caller reads as failure.
 */
import { expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { unimplementedReturnValue } from "../../src/worker/core/thunking/unimplemented-return";
import { dnsapiModule } from "../../src/worker/api/dnsapi.api";

const registry = APIRegistry.getInstance();

test("dnsapi query and free exports have their stdcall arity", () => {
    for (const name of ["DnsQuery_A", "DnsQuery_W", "DnsQuery_UTF8"]) expect(registry.getArgCount("dnsapi", name)).toBe(6);
    for (const name of ["DnsFree", "DnsRecordListFree"]) expect(registry.getArgCount("dnsapi", name)).toBe(2);
    expect(registry.getArgCount("winhttp", "WinHttpGetIEProxyConfigForCurrentUser")).toBe(1);
});

test("an unimplemented DnsQuery reports a DNS_STATUS failure, not success", () => {
    const fn = dnsapiModule.functions.find((f) => f.name === "DnsQuery_A")!;
    expect(unimplementedReturnValue(fn.onUnimplemented!)).not.toBe(0);
});
