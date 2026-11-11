import test from "node:test";
import assert from "node:assert/strict";
import { bytesHex, checkK8Payload, expectedK8Payload } from "./stack-oracle.mjs";

test("independent payload oracle covers all stores and untouched row padding", () => {
    const bytes = expectedK8Payload();
    const region = () => [{ name: "K8_DST", len: bytes.length, hex: bytesHex(bytes) }];
    assert.equal(checkK8Payload(region()).checkedBytes, 512);
    for (const at of [0, 32, 448 + 28, 511]) {
        bytes[at] ^= 1;
        assert.throws(() => checkK8Payload(region()), /mismatch/);
        bytes[at] ^= 1;
    }
    assert.throws(() => checkK8Payload([]), /missing/);
});
