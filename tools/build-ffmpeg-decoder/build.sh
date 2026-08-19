#!/usr/bin/env bash
# build.sh — Build video-decoder.wasm using Emscripten + FFmpeg
#
# Requirements (WSL2 / macOS / Linux):
#   - Emscripten SDK:  https://emscripten.org/docs/getting_started/downloads.html
#     Windows:  run this script inside WSL2  (wsl bash tools/build-ffmpeg-decoder/build.sh)
#     macOS:    brew install emscripten  OR  emsdk install latest
#     Linux:    emsdk install latest && emsdk activate latest
#   - Standard build tools: make, git, pkg-config
#   - nasm / yasm are NOT needed (--disable-x86asm)
#   - A Windows checkout with core.autocrlf=true CRLF-ifies this file, and bash then rejects
#     line 1 of `set -euo pipefail`; run a `tr -d '\r'` copy, or check out with LF.
#
# Output: public/video-decoder.wasm   (+ public/video-decoder.js glue)
#
# The pre-built output is committed to git so developers without emsdk
# don't need to rebuild.  Re-run only when decoder_api.c changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Build/output locations are overridable so a candidate build can be staged and A/B'd
# without overwriting the shipped public/ artifact that a running emulator is loading.
BUILD_DIR="${BS_FFMPEG_BUILD_DIR:-$PROJECT_ROOT/.build-ffmpeg}"
FFMPEG_DIR="$BUILD_DIR/ffmpeg"
OUTPUT_DIR="${BS_FFMPEG_OUT_DIR:-$PROJECT_ROOT/public}"

# WASM SIMD (simd128), OPT-IN. FFmpeg's hand-written DSP is disabled below (--disable-x86asm /
# --disable-inline-asm), so every codec and swscale's YUV->BGRA converter runs the pure-C path,
# and -msimd128 is what would let LLVM auto-vectorize it. MEASURED: it does vectorize (79k SIMD
# instructions vs 0) and decodes bit-identical pixels, but a full decode of a real 640x100/110f
# AVI is 15.3ms vs 14.9ms scalar -- no gain, and +20% binary (3.76MB vs 3.13MB). Decode is
# ~0.14ms/frame either way, so this is simply not where video time goes; do not enable it
# without a profile that puts a decoder loop on the hot path. Set BS_FFMPEG_SIMD=1 to build it.
if [[ "${BS_FFMPEG_SIMD:-0}" == "1" ]]; then
    SIMD_FLAGS="-msimd128"
else
    SIMD_FLAGS=""
fi

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

# ── Activate emsdk if not already on PATH ─────────────────────────────────────
if ! command -v emcc &>/dev/null; then
    # Try common locations
    for candidate in \
        "$HOME/emsdk/emsdk_env.sh" \
        "/opt/homebrew/opt/emscripten/libexec/emsdk_env.sh" \
        "/usr/local/emsdk/emsdk_env.sh"
    do
        if [[ -f "$candidate" ]]; then
            echo "[build] Sourcing emsdk from $candidate"
            # shellcheck source=/dev/null
            source "$candidate"
            break
        fi
    done
fi

if ! command -v emcc &>/dev/null; then
    echo "ERROR: emcc not found. Install Emscripten SDK and try again." >&2
    echo "  See: https://emscripten.org/docs/getting_started/downloads.html" >&2
    exit 1
fi

echo "[build] Emscripten: $(emcc --version | head -1)"

# ── Clone / update FFmpeg ──────────────────────────────────────────────────────
if [[ ! -d "$FFMPEG_DIR/.git" ]]; then
    echo "[build] Cloning FFmpeg (n6.1 branch) …"
    git clone --depth 1 --branch n6.1 https://github.com/FFmpeg/FFmpeg.git "$FFMPEG_DIR"
else
    echo "[build] FFmpeg already present at $FFMPEG_DIR"
fi

# ── Configure FFmpeg for WASM ──────────────────────────────────────────────────
FFMPEG_INSTALL="$BUILD_DIR/ffmpeg-install"
mkdir -p "$FFMPEG_INSTALL"

cd "$FFMPEG_DIR"

echo "[build] Configuring FFmpeg (curated legacy-game video set) …"

# Curated for legacy PC-game video. NOTE: component names are FFmpeg's CONFIG names, which
# are NOT always the runtime AVInputFormat.name — e.g. the MPEG Program Stream demuxer's
# config name is `mpegps` (its runtime name is `mpeg`). The old list used `--enable-demuxer=mpeg`,
# which is not a real component, so it silently enabled NOTHING and GTA III's Logo.mpg
# (mpeg1video PS) failed to open. Every name below is verified against `./configure
# --list-demuxers`/`--list-decoders`, and every enabled demuxer has its decoders enabled too.
# Bink is another name trap: the runtime codec reports "binkvideo", but the
# decoder component enabled by configure is "bink" (see configure's bink_decoder).
# (A broader "all decoders" build works but is ~10 MB; this curated set stays lean.)
emconfigure ./configure \
    --prefix="$FFMPEG_INSTALL" \
    --disable-everything \
    --enable-demuxer=bink,smacker,avi,mov,asf,flv,ogg,mpegps,mpegvideo,mpegts,roq,vmd,flic,dv,wav,idcin,fourxm,str \
    --enable-decoder=bink,smacker,cinepak,indeo2,indeo3,indeo4,indeo5,msvideo1,msrle,rawvideo,mjpeg,mjpegb \
    --enable-decoder=mpeg1video,mpeg2video,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,h263,h263i,h263p \
    --enable-decoder=wmv1,wmv2,wmv3,vc1,flv,vp3,vp5,vp6,vp6a,vp6f,svq1,svq3,rpza,qtrle,smc,qdraw,qpeg,tscc,tscc2 \
    --enable-decoder=roq,truemotion1,truemotion2,dvvideo,flic,idcin,interplay_video,mdec,fourxm,cdgraphics,theora \
    --enable-decoder=mp2,mp2float,mp3,mp3float,wmav1,wmav2,vorbis,smackaud,binkaudio_dct,binkaudio_rdft \
    --enable-decoder=roq_dpcm,vmdaudio,nellymoser,qdm2,truespeech,interplay_dpcm,xan_dpcm \
    --enable-decoder=pcm_u8,pcm_s8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le,pcm_f32le,pcm_alaw,pcm_mulaw \
    --enable-decoder=adpcm_ms,adpcm_ima_wav,adpcm_ima_ws,adpcm_ima_qt,adpcm_ea,adpcm_xa,adpcm_swf,adpcm_4xm,adpcm_g726 \
    --enable-parser=mpegvideo,mpeg4,mpegaudio,h263,vorbis,vp3,vc1 \
    --enable-protocol=pipe \
    --enable-avformat \
    --enable-avcodec \
    --enable-avutil \
    --enable-swscale \
    --enable-swresample \
    --disable-programs \
    --disable-doc \
    --disable-x86asm \
    --disable-inline-asm \
    --disable-pthreads \
    --disable-network \
    --disable-debug \
    --enable-cross-compile \
    --target-os=none \
    --arch=c \
    --cc=emcc \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-O2 $SIMD_FLAGS" \
    --disable-autodetect \
    --disable-iconv \
    --disable-zlib \
    --disable-bzlib \
    --disable-lzma \
    --disable-sdl2

echo "[build] Cleaning previous FFmpeg build (ensures codec changes take effect) …"
emmake make clean 2>/dev/null || true

echo "[build] Building FFmpeg libraries …"
emmake make -j"${NPROC:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}" \
    install-libs install-headers

# ── Compile decoder_api.c → video-decoder.wasm ────────────────────────────────
cd "$PROJECT_ROOT"

echo "[build] Linking decoder_api.c with FFmpeg …"

EXPORTED_FUNCTIONS=(
    "_decoder_alloc"
    "_decoder_free"
    "_decoder_open"
    "_decoder_do_frame"
    "_decoder_copy_frame_rgba"
    "_decoder_get_frame_rgba_ptr"
    "_decoder_get_frame_rgb565_ptr"
    "_decoder_has_pal8"
    "_decoder_get_frame_pal8_ptr"
    "_decoder_get_frame_palette_ptr"
    "_decoder_get_audio_frame"
    "_decoder_get_audio_available"
    "_decoder_next_frame"
    "_decoder_wait"
    "_decoder_get_width"
    "_decoder_get_height"
    "_decoder_get_frame_count"
    "_decoder_get_current_frame"
    "_decoder_get_fps"
    "_decoder_get_audio_sample_rate"
    "_decoder_get_audio_channels"
    "_decoder_goto_frame"
    "_decoder_close"
    "_decoder_get_video_codec_id"
    "_decoder_get_video_codec_name"
    "_decoder_get_video_fourcc"
    "_decoder_get_video_pix_fmt"
)

# Build JSON array of exported function names
EXPORT_JSON=$(printf '%s\n' "${EXPORTED_FUNCTIONS[@]}" | \
    python3 -c "import sys,json; print(json.dumps(sys.stdin.read().split()))")

emcc tools/build-ffmpeg-decoder/decoder_api.c \
    -I"$FFMPEG_INSTALL/include" \
    -L"$FFMPEG_INSTALL/lib" \
    -lavformat -lavcodec -lavutil -lswscale -lswresample \
    -s WASM=1 \
    -s STANDALONE_WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS="$EXPORT_JSON" \
    -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
    -s INITIAL_MEMORY=67108864 \
    -O2 $SIMD_FLAGS \
    -o "$OUTPUT_DIR/video-decoder.wasm"

echo "[build] Done: $OUTPUT_DIR/video-decoder.wasm"
echo "[build] Size: $(du -sh "$OUTPUT_DIR/video-decoder.wasm" | cut -f1)"
