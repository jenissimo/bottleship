# Static server bundle directory

`BS_APPS_DIR` must name a directory that is readable when the server starts; an unavailable directory stops startup with exit code 1. `/apps/` serves only regular `.wgb` files. Symlinks within that directory are supported, but links resolving outside it return 404. For bundles on another disk, mount that storage under the configured directory rather than linking to an external path.
