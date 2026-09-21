/**
 * GetParameterDesc must answer for an ANNOTATION handle.
 *
 * An annotation IS a parameter in D3DX's model, and reading its NAME back through
 * GetParameterDesc is how an app identifies one. A SAS engine enumerates each parameter's
 * annotations and reads their descs looking for "SasBindAddress"; refusing the handle leaves it
 * able to read an annotation's VALUE (GetString accepts the handle) but never its NAME, so no
 * binding can ever be identified and every texture binds NULL.
 *
 * That was RA3's blocker. Pinned at the handle layer, which is where the refusal lived.
 */
import { describe, expect, test } from "bun:test";
import {
    decodeHandle,
    handleForAnnotation,
    handleForParameter,
    isAnnotationHandle,
    isParameterHandle,
} from "../../src/worker/modules/d3dx9/effect-state";

describe("annotation handles are distinguishable and resolvable", () => {
    test("an annotation handle is an ANNOTATION, not a parameter", () => {
        const h = decodeHandle(handleForAnnotation(4))!;
        expect(isAnnotationHandle(h)).toBe(true);
        // The regression: GetParameterDesc went through a parameter-only resolver, so an
        // annotation handle fell through to D3DERR_INVALIDCALL.
        expect(isParameterHandle(h)).toBe(false);
        expect(h.index).toBe(4);
    });

    test("annotation and parameter handles of the same index are different values", () => {
        expect(handleForAnnotation(4)).not.toBe(handleForParameter(4));
    });

    test("every annotation index round-trips", () => {
        for (const i of [0, 1, 17, 255, 1000]) {
            const h = decodeHandle(handleForAnnotation(i))!;
            expect(isAnnotationHandle(h)).toBe(true);
            expect(h.index).toBe(i);
        }
    });
});
