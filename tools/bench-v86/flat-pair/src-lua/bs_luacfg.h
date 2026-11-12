/* Force-included into every Lua translation unit, in every arm (MSVC /FI, clang -include). */
#ifndef BS_LUACFG_H
#define BS_LUACFG_H
/* C89 mode: lua_Integer = long (32-bit on x86 and wasm32), lua_Number = double, sprintf/strtod. */
#define LUA_USE_C89 1
/* No setjmp/longjmp: the scripts raise no errors and use no coroutines, so a protected call is
 * just a call. A throw (should one ever happen) stops the run with a marker. */
void bs_lua_throw(int status);
#define LUAI_THROW(L, c) bs_lua_throw((c)->status)
#define LUAI_TRY(L, c, a) { a }
#define luai_jmpbuf int
/* Fixed string-hash seed: no time(), no address-derived randomness. */
#define luai_makeseed(L) (0x2545F491u)
#define lua_getlocaledecpoint() '.'
#endif
