"""Build the CPU-only WebWindows provider used by BottleShip from a pinned source archive."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

REVISION = "5c845c1b45659cfb5ed00a0da5d3870025c022f3"
SHA256 = "80f1cf88b45436c0fa3765f1d2955f6faf000f971bf833c350273bd5b16b9408"
ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help=f"GitHub tar.gz for Glavin001/WebWindows at {REVISION}")
    parser.add_argument("output", type=Path, help="directory passed to BS_WWT_PROVIDER_DIR")
    parser.add_argument("--offline", action="store_true", help="use the local Cargo cache")
    parser.add_argument("--vendor", type=Path, help="optional cargo-vendor directory for an offline build")
    args = parser.parse_args()
    if hashlib.sha256(args.archive.read_bytes()).hexdigest() != SHA256:
        parser.error(f"archive checksum mismatch for {REVISION}")
    output = args.output.resolve()
    with tempfile.TemporaryDirectory(prefix="bottleship-wwt-") as temp:
        workspace = Path(temp)
        with tarfile.open(args.archive, "r:gz") as archive:
            prefix = "WebWindows-" + REVISION + "/"
            for entry in archive:
                if not entry.isfile() or not entry.name.startswith(prefix):
                    continue
                name = entry.name[len(prefix):]
                if not name.startswith(("crates/wwt/", "crates/wwt-wasm/")):
                    continue
                path = workspace / name
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("wb") as dest:
                    shutil.copyfileobj(archive.extractfile(entry), dest)
        # Build the two translation crates without unrelated graphics and Wine tools.
        shutil.copyfile(ROOT / "Cargo.toml", workspace / "Cargo.toml")
        shutil.copyfile(ROOT / "Cargo.lock", workspace / "Cargo.lock")
        crate = workspace / "crates/wwt/Cargo.toml"
        crate.write_text(crate.read_text().split("[dev-dependencies]")[0], encoding="utf-8")
        for patch in ("bottleship.patch", "protected-x87-int64.patch"):
            subprocess.run(["git", "apply", "--whitespace=nowarn", str(ROOT / patch)], cwd=workspace, check=True)
        target = Path(os.environ.get("CARGO_TARGET_DIR", workspace / "target")).resolve()
        command = ["cargo", "build", "--locked", "-p", "wwt-wasm", "--target", "wasm32-unknown-unknown",
                   "--profile", "release-wasm", "--target-dir", str(target)]
        if args.offline or args.vendor:
            command.append("--offline")
        if args.vendor:
            directory = args.vendor.resolve().as_posix().replace('"', '\\"')
            command += ["--config", 'source.crates-io.replace-with="bottleship-vendor"',
                        "--config", f'source.bottleship-vendor.directory="{directory}"']
        subprocess.run(command, cwd=workspace, check=True)
        output.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(target / "wasm32-unknown-unknown/release-wasm/wwt_wasm.wasm", output / "wwt_wasm.wasm")


if __name__ == "__main__":
    main()
