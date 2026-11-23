# BottleShip kernels migrated from its v86 fork

These files are snapshots from BottleShip’s v86 fork at revision `b9b56ea11592ca53182b77016abccfa7104c0fb8`.

- `hypercall_rtti.rs` comes from `src/rust/cpu/hypercall_rtti.rs`. The WWT variant passes a guarded memory context through the original cast algorithm.
- `arena.rs` and `guest_mem.rs` come from `crates/d3d9-webgpu/src/`.

`eagl_apply.rs` and `eagl_token.rs` adapt the shader parameter walkers and token routing in `src/rust/cpu/hypercall_eagl.rs` to the WWT guest-memory interface.

The included BSD-2-Clause license covers these sources. The WWT build uses the copies in this directory and works without the v86 submodule. The native v86 build keeps its original sources.
