-- flat-pair Lua workload: a deterministic mix of ordinary interpreter work. Integers are 32-bit
-- (LUA_USE_C89: lua_Integer = long), floats are only exact dyadic values, nothing depends on
-- addresses (no tostring(table), no pairs() over non-string keys), no coroutines/pcall errors.
local M = 0x7fffffff
local h = 0
local function mix(x) h = (h * 31 + (x & M)) & M end

-- 1. recursion
local function fib(n) if n < 2 then return n end return fib(n - 1) + fib(n - 2) end

-- 2. objects with metatables
local Vec = {}
Vec.__index = Vec
function Vec.new(x, y) return setmetatable({ x = x, y = y }, Vec) end
function Vec:add(o) return Vec.new(self.x + o.x, self.y + o.y) end
function Vec:dot(o) return self.x * o.x + self.y * o.y end
local Shape = {}
Shape.__index = Shape
function Shape.new(kind, a, b) return setmetatable({ kind = kind, a = a, b = b }, Shape) end
function Shape:area()
  if self.kind == 1 then return self.a * self.a
  elseif self.kind == 2 then return self.a * self.b
  else return (self.a * self.b) // 2 end
end

-- 3. strings
local words = { "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa" }
local function strwork(r)
  local parts = {}
  for i = 1, 8 do parts[#parts + 1] = words[((r + i * 7) % #words) + 1] .. string.format("%d", (r * i) % 1000) end
  local s = table.concat(parts, ",")
  local n = 0
  for w in string.gmatch(s, "%a+") do n = n + #w end
  local t = string.gsub(s, "a", "A")
  local p = string.find(t, "eta", 1, true) or 0
  local u = string.upper(string.sub(s, 2, 12))
  return n + p + #u + string.byte(u, 1) + #string.rep("ab", r % 5)
end

-- 4. tables and sorting with a comparator closure
local function sortwork(r)
  local t = {}
  local x = r
  for i = 1, 40 do x = (x * 1103515245 + 12345) & M; t[i] = x % 997 end
  local desc = (r % 2) == 0
  table.sort(t, function(a, b) if desc then return a > b else return a < b end end)
  local acc = 0
  for i = 1, #t, 3 do acc = acc + t[i] * i end
  return acc
end

-- 5. closures / higher-order
local function map(t, f) local o = {} for i = 1, #t do o[i] = f(t[i]) end return o end
local function fold(t, f, a) for i = 1, #t do a = f(a, t[i]) end return a end
local function hof(r)
  local t = {}
  for i = 1, 16 do t[i] = (r + i * i) % 101 end
  local k = r % 7 + 1
  local m = map(t, function(v) return v * k + 1 end)
  return fold(m, function(a, v) return (a * 3 + v) & M end, 0)
end

-- 6. exact float arithmetic
local function fwork(r)
  local a, b = (r % 1000) * 0.5, (r % 77) * 0.25
  local s = 0.0
  for i = 1, 10 do s = s + a * b - i * 0.125; a = a + 0.5 end
  return math.floor(s) + math.floor(math.sqrt(16.0 * (r % 50 + 1) * (r % 50 + 1)))
end

-- 7. string-keyed records (hash part)
local function recwork(r)
  local rec = {}
  for i = 1, 12 do rec[words[(i + r) % #words + 1] .. i] = i * r % 313 end
  local acc = 0
  for i = 1, 12 do acc = acc + (rec[words[(i + r) % #words + 1] .. i] or 0) end
  return acc
end

local shapes = {}
for i = 1, 32 do shapes[i] = Shape.new(i % 3 + 1, i % 17 + 1, i % 13 + 2) end

local kinds = {
  function(r) return fib(10 + r % 6) end,
  function(r)
    local v = Vec.new(r % 10, r % 7)
    for i = 1, 20 do v = v:add(Vec.new(i, -i)) end
    local acc = 0
    for i = 1, #shapes do acc = acc + shapes[(i + r) % #shapes + 1]:area() end
    return v:dot(Vec.new(3, 5)) + acc
  end,
  strwork, sortwork, hof, fwork, recwork,
}

function run(steps, seed)
  h = seed & M
  local r = seed & M
  for i = 1, steps do
    r = (r * 1103515245 + 12345) & M
    local k = (r >> 8) % #kinds + 1
    mix(kinds[k](r >> 4))
  end
  print(string.format("steps=%d h=%d", steps, h))
  return h
end
