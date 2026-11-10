# func-ceiling measurement campaign (all series pinned to logical cores 12-15; ABBA; A/A arms).
# Prerequisites: flat-pair builds (tight-int, medium-int, flat-int, flat-int-pad3, tight, medium, flat)
# and `node build-fc.mjs ...` (see README). Results: out/results/*.json, tables: summarize-fc.mjs.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$A = "0xF000"
# 1. ladder + ablations, integer workloads, TurboFan-only + branch hints (both engines)
node bench-fc.mjs --workloads tight-int,medium-int --affinity $A --rounds 4 --tag final-ladder-tm --arms "v86@tfhint em@tfhint native fc:F0@tfhint fc:F0b@tfhint fc:RC@tfhint fc:RT@tfhint fc:LZ@tfhint fc:S@tfhint fc:Sb@tfhint fc:S-exec@tfhint fc:F0G@tfhint fc:F0Z@tfhint fc:RTG@tfhint fc:SnoRT@tfhint fc:S-sf@tfhint fc:S@tfhint#aa v86@tfhint#aa"
# 2. the decision workload, more rounds
node bench-fc.mjs --workloads flat-int --affinity $A --rounds 8 --tag final-flat-tf --arms "v86@tfhint v86@tfhint#aa em@tfhint fc:F0@tfhint fc:F0b@tfhint fc:RC@tfhint fc:RT@tfhint fc:LZ@tfhint fc:S@tfhint fc:Sb@tfhint fc:S-sf@tfhint fc:F0G@tfhint fc:RTG@tfhint fc:S@tfhint#aa"
# 3. same, V8 default dynamic tiering (Liftoff first), hints on
node bench-fc.mjs --workloads flat-int --affinity $A --rounds 6 --tag final-flat-dyn --arms "v86@hint v86@hint#aa em@hint fc:F0@hint fc:LZ@hint fc:S@hint fc:S@hint#aa"
# 4. executed-only vs all-reachable (3 never-called functions per live function)
node bench-fc.mjs --workloads flat-int-pad3 --affinity $A --rounds 4 --tag final-pad3 --arms "v86@tfhint em@tfhint fc:F0@tfhint fc:F0-exec@tfhint fc:S@tfhint fc:S-exec@tfhint fc:S@tfhint#aa"
# 5. stage 2: x87 workloads
node bench-fc.mjs --workloads tight,medium,flat --affinity $A --rounds 4 --tag final-x87 --arms "v86@tfhint em@tfhint native fc:F0@tfhint fc:RT@tfhint fc:LZ@tfhint fc:S@tfhint fc:S@tfhint#aa"
