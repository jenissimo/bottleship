# Versions and releases

The root `package.json` is the source of BottleShip's release version. Vite injects
it into the library header and Settings → About. The About panel also shows the
build's Git commit, so builds within a release can be distinguished.

Versions use `major.minor.patch`; Git tags use `v<version>`. The current release is
**0.7** (`0.7.0`, tag `v0.7.0`). While BottleShip is below 1.0, feature milestones
increment the minor version and maintenance releases increment the patch version.

To prepare a release:

1. Update `version` in the root `package.json` and regenerate `bun.lock` with
   `bun install --lockfile-only`.
2. Write English notes in this directory and add the release to `CHANGELOG.md` and
   `README.md`. Cover changes merged into `main` since the preceding release.
3. Run the repository's ordered quality checks, type checking and production build.
   Merge the release commit into `main` and wait for CI to pass.
4. Create an annotated `v<version>` tag on that validated commit, push the tag and
   publish a GitHub Release using the saved notes. The library's version link opens
   that tag's release page.

The first numbered release, 0.7, covers changes merged into `main` from October 5
through October 8, 2026. GitHub provides source archives for its tagged snapshot;
the live browser application remains at [bottleship.pages.dev](https://bottleship.pages.dev/).

- [0.7 release notes](0.7.md)
