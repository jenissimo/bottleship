param([int]$BrowserPid, [string]$OutputFile)
# Read-only diagnostic sampler. Its overhead makes this unsuitable for perf acceptance.
$ErrorActionPreference = 'Stop'
while (Get-Process -Id $BrowserPid -ErrorAction SilentlyContinue) {
    $sampleStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $processorRows = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation |
        Select-Object Name, ProcessorFrequency, PercentProcessorPerformance, PercentProcessorUtility
    $sampleEnded = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    @{ startedMs=$sampleStarted; endedMs=$sampleEnded; processors=@($processorRows) } |
        ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath $OutputFile -Encoding UTF8
    Start-Sleep -Milliseconds 1000
}
