/**
 * GetParameter/GetParameterElement/GetParameterByName take an hParent, and a non-NULL one
 * scopes the query to that parameter's MEMBERS. Ignoring it answered a struct-member query with
 * an unrelated TOP-LEVEL parameter — a handle whose name, type and value belong to something
 * else, which an engine then binds its material data to.
 *
 * Pinned at the handle layer: a member handle must round-trip to the member, not to
 * parameters[index].
 */
import { describe, expect, test } from "bun:test";
import {
    decodeHandle,
    handleForMember,
    handleForParameter,
    isParameterHandle,
} from "../../src/worker/modules/d3dx9/effect-state";

describe("effect parameter handles", () => {
    test("a top-level handle carries no parent", () => {
        const h = decodeHandle(handleForParameter(7))!;
        expect(isParameterHandle(h)).toBe(true);
        expect(h.index).toBe(7);
        expect(h.sub).toBeLessThan(0);          // no parent => resolve against the top level
    });

    test("a member handle carries BOTH the parent and the member index", () => {
        const h = decodeHandle(handleForMember(3, 5))!;
        expect(isParameterHandle(h)).toBe(true);
        expect(h.sub).toBe(3);                  // the owning top-level parameter
        expect(h.index).toBe(5);                // the member within it
    });

    test("a member handle is distinct from the top-level handle of the same index", () => {
        expect(handleForMember(3, 5)).not.toBe(handleForParameter(5));
    });

    test("a parent index the encoding cannot represent is REFUSED, never aliased", () => {
        // `sub` is 8 bits; silently wrapping would point the handle at another parameter.
        expect(handleForMember(255, 0)).toBe(0);
    });
});
