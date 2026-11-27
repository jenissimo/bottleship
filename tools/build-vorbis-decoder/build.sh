#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="${BS_VORBIS_BUILD_DIR:-$PROJECT_ROOT/.build-vorbis}"
ZIG="${ZIG:-zig}"
STB_COMMIT="1ee679ca2ef753a528db5ba6801e1067b40481b8"
STB_SHA256="4c7cb2ff1f7011e9d67950446b7eb9ca044f2e464d76bfbb0b84dd2e23e65636"
OUT_TS="$PROJECT_ROOT/packages/formats/src/audio/vorbis-wasm.generated.ts"

mkdir -p "$BUILD_DIR"
if [[ ! -f "$BUILD_DIR/stb_vorbis.c" ]]; then
    curl -fsSL -o "$BUILD_DIR/stb_vorbis.c" "https://raw.githubusercontent.com/nothings/stb/$STB_COMMIT/stb_vorbis.c"
fi
echo "$STB_SHA256  $BUILD_DIR/stb_vorbis.c" | sha256sum -c -

"$ZIG" version
"$ZIG" cc -target wasm32-wasi -O2 -mexec-model=reactor -I"$BUILD_DIR" \
    -o "$BUILD_DIR/vorbis-decoder.wasm" "$SCRIPT_DIR/vorbis_api.c" -Wl,--strip-all

{
    echo "export const VORBIS_DECODER_WASM_BASE64 ="
    echo "    \"$(base64 -w0 "$BUILD_DIR/vorbis-decoder.wasm")\";"
} > "$OUT_TS"
sha256sum "$BUILD_DIR/vorbis-decoder.wasm"
wc -c "$BUILD_DIR/vorbis-decoder.wasm" "$OUT_TS"
