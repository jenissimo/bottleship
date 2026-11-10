// Emscripten JS library: the three platform calls go to hooks the runner passes in Module.
addToLibrary({
    bs_in: () => Module["bsIn"](),
    bs_out: (v) => Module["bsOut"](v >>> 0),
    bs_mark: (id) => Module["bsMark"](id >>> 0),
});
