# Runs a plan of desktop checks in the logged-in Windows session (started by launch-fallback.ps1).
# The plan is JSON: { "Output": folder, "Root": checkout, "Node": node.exe, "RequireGpu": true|false,
#   "Steps": [ { "Name": "desktop-smoke", "Args": ["tools\\desktop-smoke.cjs", ...], "Minutes": 8,
#                "Env": { "VEACOM_SMOKE_EXECUTABLE": "..." }, "Skip": "why it cannot run (optional)" } ] }
# Every step runs even when an earlier one fails, and fallback.json records each result. RequireGpu stops the
# plan before any step when the Tesla T4 is missing or disabled, because the app would otherwise draw through
# WARP without saying so. PATH is only System32 and Windows, so the checks find nothing from the build tools;
# that is also why Assert-Plan refuses the unit tests (node --test) here.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Plan)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-TimeRemaining 5
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'Desktop checks require the logged-in Windows session, not SSH session 0.' }
$Config = Read-Json $Plan
Assert-Plan $Config
[IO.Directory]::CreateDirectory($Config.Output) | Out-Null
$Summary = Join-Path $Config.Output 'fallback.json'
$Display = @(Get-CimInstance Win32_VideoController | ForEach-Object { [ordered]@{ name = $_.Name; status = $_.Status; driver = $_.DriverVersion;
    screen = "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)" } })
$Result = [ordered]@{ status = 'running'; plan = $Plan; started = [DateTimeOffset]::UtcNow.ToString('o');
    session = [Diagnostics.Process]::GetCurrentProcess().SessionId; display = $Display; steps = @() }
try {
    Save-Json $Summary $Result
    if (Get-Field $Config 'RequireGpu' $false) {
        $Gpu = @(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VEN_10DE' })
        if (!$Gpu.Count -or @($Gpu | Where-Object { $_.Status -ne 'OK' }).Count) {
            throw ('The Tesla T4 is missing or not working (' + (($Gpu | ForEach-Object { "$($_.FriendlyName): $($_.Status)" }) -join '; ') + '). ' +
                'Run display-adapter.ps1 -Action Enable, then start the checks again.')
        }
    }
    $env:PATH = "$env:WINDIR\System32;$env:WINDIR"
    foreach ($Step in @($Config.Steps)) {
        foreach ($Variable in $script:PlanEnvironment) { Remove-Item "Env:$Variable" -ErrorAction SilentlyContinue }
        $Entry = [ordered]@{ name = $Step.Name; started = [DateTimeOffset]::UtcNow.ToString('o') }
        $Skip = Get-Field $Step 'Skip'
        if ($Skip) { $Entry.status = 'skipped'; $Entry.reason = $Skip }
        else {
            $Variables = Get-Field $Step 'Env'
            if ($Variables) { foreach ($Pair in $Variables.PSObject.Properties) { Set-Item "Env:$($Pair.Name)" ([string]$Pair.Value) } }
            try {
                Invoke-LoggedTool -Name $Step.Name -Executable $Config.Node -Arguments ([string[]]$Step.Args) -WorkingDirectory $Config.Root `
                    -OutputDirectory $Config.Output -TimeoutMinutes ([int]$Step.Minutes) | Out-Null
                $Entry.status = 'passed'
            } catch { $Entry.status = 'failed'; $Entry.error = $_.Exception.Message }
        }
        $Entry.finished = [DateTimeOffset]::UtcNow.ToString('o')
        $Result.steps += $Entry
        Save-Json $Summary $Result
    }
    $Result.status = if (@($Result.steps | Where-Object { $_.status -eq 'failed' }).Count) { 'failed' } else { 'passed' }
} catch { $Result.status = 'failed'; $Result.error = $_.Exception.Message; throw }
finally {
    $Result.finished = [DateTimeOffset]::UtcNow.ToString('o')
    Save-Json $Summary $Result
}
