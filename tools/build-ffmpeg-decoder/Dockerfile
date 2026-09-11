# Dockerfile for building video-decoder.wasm
# Optional: use this if you prefer a containerised build instead of WSL2/native.
#
# Build:
#   docker build -t bottleship-ffmpeg-builder tools/build-ffmpeg-decoder/
#
# Run (from project root):
#   docker run --rm \
#     -v "$(pwd):/project" \
#     -w /project \
#     bottleship-ffmpeg-builder \
#     bash tools/build-ffmpeg-decoder/build.sh
#
# From Git Bash on Windows the same run needs three adjustments: MSYS path conversion off
# (or "/project" becomes "C:/Program Files/Git/project"), the FFmpeg build tree on a named
# volume (a bind mount under /project makes configure+make take ~10x longer), and an LF copy
# of build.sh if the checkout is CRLF (bash rejects `set -euo pipefail` on line 1 otherwise):
#   tr -d '\r' < tools/build-ffmpeg-decoder/build.sh > tools/build-ffmpeg-decoder/build.lf.sh
#   MSYS_NO_PATHCONV=1 docker run --rm -v "C:/path/to/repo:/project" \
#     -v bs-ffmpeg-build:/ffbuild -e BS_FFMPEG_BUILD_DIR=/ffbuild -w /project \
#     bottleship-ffmpeg-builder bash tools/build-ffmpeg-decoder/build.lf.sh

FROM emscripten/emsdk:3.1.64

RUN apt-get update && apt-get install -y --no-install-recommends \
    git make pkg-config python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /project
