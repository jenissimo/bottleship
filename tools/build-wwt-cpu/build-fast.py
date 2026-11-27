"""Rebuild the fast i386 compiler and verify its unmodified Wine reference."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

from build import REVISION, ROOT, SHA256

RUST_HOST = "x86_64-unknown-linux-gnu"
RUST_COMMIT = "b940084d7eb6a299eb4bfeb8e34901bc051e7ac4"
WINE_PROVIDER_SHA256 = "95f8ad6ee983acd0f7f466f25ebe71be3965da796d47befbc44b1cf56e958f42"
CI_REGISTRY = "/home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f"
PATCHES = [ROOT / name for name in ("abi11-osr-preempt.patch", "abi11-pe-progress.patch", "abi11-x87-int64.patch")]


def sha256(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help=f"GitHub source archive at {REVISION}")
    parser.add_argument("output", type=Path, help="directory to write wwt_abi11.wasm")
    parser.add_argument("--offline", action="store_true", help="use the local Cargo cache")
    parser.add_argument("--vendor", type=Path, help="use an existing cargo-vendor directory")
    args = parser.parse_args()

    if sha256(args.archive) != SHA256:
        parser.error(f"archive checksum mismatch for {REVISION}")

    vendor = args.vendor.resolve() if args.vendor else None
    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")).resolve()
    registry = vendor or cargo_home / "registry/src/index.crates.io-1949cf8c6b5b557f"
    env = dict(os.environ, CARGO_INCREMENTAL="0", CARGO_ENCODED_RUSTFLAGS=f"--remap-path-prefix={registry}={CI_REGISTRY}")

    command = ["cargo", "build", "--locked", "-p", "wwt-wasm", "-p", "wwt-heap", "-p", "wwt-strings",
               "--target", "wasm32-unknown-unknown", "--profile", "release-wasm"]
    if args.offline or vendor:
        command.append("--offline")
    if vendor:
        command.extend(["--config", 'source.crates-io.replace-with="bottleship-vendor"',
                        "--config", f"source.bottleship-vendor.directory={json.dumps(vendor.as_posix())}"])

    with tempfile.TemporaryDirectory(prefix="bottleship-abi11-") as tmp:
        workspace = Path(tmp) / f"WebWindows-{REVISION}"
        with tarfile.open(args.archive, "r:gz") as archive:
            archive.extractall(tmp, filter="data")

        toolchain = subprocess.check_output(["rustc", "-vV"], cwd=workspace, env=env, text=True)
        required = {f"host: {RUST_HOST}", "release: 1.99.0", f"commit-hash: {RUST_COMMIT}"}
        if not required.issubset(toolchain.splitlines()):
            parser.error("select Rust 1.99.0 for x86_64 Linux before building")
        print(toolchain.rstrip(), flush=True)

        target = Path(os.environ.get("CARGO_TARGET_DIR", workspace / "target")).resolve()
        command.extend(["--target-dir", str(target)])
        artifact = target / "wasm32-unknown-unknown/release-wasm/wwt_wasm.wasm"

        subprocess.run(command, cwd=workspace, env=env, check=True)
        original = sha256(artifact)
        print(f"WebWindows + Wine reference SHA-256 {original}", flush=True)
        if original != WINE_PROVIDER_SHA256:
            parser.error(f"clean compiler differs from the Wine reference ({WINE_PROVIDER_SHA256})")

        for patch in PATCHES:
            subprocess.run(["git", "apply", "--whitespace=nowarn", str(patch)], cwd=workspace, check=True)
        subprocess.run(command, cwd=workspace, env=env, check=True)

        args.output.mkdir(parents=True, exist_ok=True)
        dest = args.output / "wwt_abi11.wasm"
        shutil.copyfile(artifact, dest)
        print(f"BottleShip ABI11 SHA-256 {sha256(dest)}  {dest}", flush=True)


if __name__ == "__main__":
    main()
