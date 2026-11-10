# The whole B0a measurement campaign, pinned to CCD0 logical CPUs 4-7 (see README: on the
# 7900X3D an unpinned run lands on either CCD and the big-code workloads move 2.3x).
#   powershell -File campaign.ps1 [-Mask 0xF0] [-Rounds 4] [-Part all|main|lua|cfg|sweep|char]
param([string]$Mask = "0xF0", [int]$Rounds = 4, [string]$Part = "all")
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$all = $Part -eq "all"
if ($all -or $Part -eq "char") {
    node characterize.mjs --affinity $Mask --workloads "tight,medium,flat,flat-dfs,lua" --tag char
    node characterize.mjs --affinity $Mask --workloads "flat-n60,flat-n600,flat-n18k,flat-s8" --tag char-sweep
}
if ($all -or $Part -eq "main") {
    node bench.mjs --affinity $Mask --workloads "tight,medium,flat" --arms "v86 v86#aa em llvm-v86 native llvm-native" --rounds $Rounds --tag main
}
if ($all -or $Part -eq "lua") {
    node bench.mjs --affinity $Mask --workloads "lua" --arms "v86 v86#aa em llvm-v86 native llvm-native" --rounds $Rounds --tag lua
}
if ($all -or $Part -eq "cfg") {
    node bench.mjs --affinity $Mask --workloads "flat,flat-dfs,lua" --arms "v86 v86[4=1] v86[12=0,13=0] v86[21=1] v86[1=1] v86[1=8] v86@liftoff em" --rounds $Rounds --tag cfg
}
if ($all -or $Part -eq "cfgchar") {
    # what each config switch does to the exit mix and to the emitted code volume
    node characterize.mjs --affinity $Mask --workloads "flat,flat-dfs,lua" --arms "v86[4=1] v86[12=0,13=0] v86[1=1] v86[1=8]" --tag char-cfg
}
if ($all -or $Part -eq "ccd1") {
    # the same runs on the CCD WITHOUT 3D V-cache (32 MiB L3 instead of 96): cache sensitivity
    node bench.mjs --affinity 0xF000 --workloads "flat-n60,flat-n600,flat,lua" --arms "v86 em" --rounds 2 --tag ccd1
}
if ($all -or $Part -eq "sweep") {
    node bench.mjs --affinity $Mask --workloads "flat-n60,flat-n600,flat,flat-n18k,flat-s8,flat-dfs" --arms "v86 em" --rounds $Rounds --tag sweep
}
