import * as L from "../../aot-oracle/corpus/layout.mjs";

export function k8Source() {
    const bytes = new Uint8Array(L.K8_ROWS * L.K8_SRC_STRIDE);
    for (let row = 0; row < L.K8_ROWS; row++) {
        for (let col = 0; col < L.K8_COLS; col++) {
            bytes[row * L.K8_SRC_STRIDE + col] = (row * 37 + col * 11 + 1) & 255;
        }
    }
    return bytes;
}

export function expectedK8Payload(source = k8Source(), bias = L.K8_BIAS) {
    const bytes = new Uint8Array(L.K8_ROWS * L.K8_ROW_DST_STRIDE);
    const view = new DataView(bytes.buffer);
    for (let row = 0; row < L.K8_ROWS; row++) {
        for (let col = 0; col < L.K8_COLS; col++) {
            view.setUint32(row * L.K8_ROW_DST_STRIDE + col * 4,
                ((source[row * L.K8_SRC_STRIDE + col] + bias) << 16) >>> 0, true);
        }
    }
    return bytes;
}

export function bytesHex(bytes) {
    return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

export function checkK8Payload(regions) {
    const output = regions.find(region => region.name === "K8_DST");
    if (!output || output.len !== L.K8_ROWS * L.K8_ROW_DST_STRIDE) {
        throw new Error("missing complete K8_DST output");
    }
    const expected = bytesHex(expectedK8Payload());
    if (output.hex !== expected) {
        const at = Array.from({ length: expected.length / 2 }, (_, i) => i)
            .find(i => output.hex.slice(i * 2, i * 2 + 2) !== expected.slice(i * 2, i * 2 + 2));
        throw new Error(`independent K8 payload mismatch at byte ${at}`);
    }
    return { checkedBytes: expected.length / 2, outputCells: L.K8_ROWS * L.K8_COLS };
}
