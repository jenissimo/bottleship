$ErrorActionPreference = 'Stop'
bun (Join-Path $PSScriptRoot 'build.mjs')
exit $LASTEXITCODE
