# Shared by the VM kit's scripts; dot-source it after param(). It reads the fixed stop deadline that
# stage.ps1 copied from the instance's GCP terminationTime, and never extends it.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:KitBase = Join-Path $env:SystemDrive 'veacom'
$DeadlineFile = Join-Path $script:KitBase 'vm-stop-deadline.txt'
if (!(Test-Path -LiteralPath $DeadlineFile -PathType Leaf)) { throw "Record the VM's GCP terminationTime in $DeadlineFile first; vm.sh stage does that." }
$DeadlineText = (Get-Content -LiteralPath $DeadlineFile -Raw).Trim()
if ($DeadlineText -notmatch '(Z|[+-]\d\d:\d\d)$') { throw 'The fixed VM deadline must include its UTC offset.' }
$script:StopDeadline = [DateTimeOffset]::Parse($DeadlineText, [Globalization.CultureInfo]::InvariantCulture).ToUniversalTime()
$script:SafetyMargin = [TimeSpan]::FromMinutes(5)
# The only variables a desktop-check plan may set for its steps.
$script:PlanEnvironment = @('VEACOM_SMOKE_EXECUTABLE', 'VEACOM_SMOKE_RENDERER', 'VEACOM_TEST_URL', 'VEACOM_CORE_PATH', 'VEACOM_DEV_URL')

function Assert-TimeRemaining([int]$Minutes = 1) {
    if ([DateTimeOffset]::UtcNow.AddMinutes($Minutes) -ge ($script:StopDeadline - $script:SafetyMargin)) {
        throw 'The fixed VM stop deadline is too close or has passed. Stop work; do not extend it automatically.'
    }
}
function Save-Json([string]$Path, $Value) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 15), (New-Object Text.UTF8Encoding $false))
}
# Get-Content in Windows PowerShell reads a file without a byte-order mark as ANSI; this reads UTF-8.
function Read-Json([string]$Path) { [IO.File]::ReadAllText($Path) | ConvertFrom-Json }
# A property of a JSON object, or $Default when it is absent (strict mode throws on a missing property).
function Get-Field($Object, [string]$Name, $Default = $null) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $Default
}
# The staged source and the evidence of one pull request run, e.g. C:\veacom\pr27 and C:\veacom\pr27-evidence.
function Get-RunPaths([string]$Name) {
    if ($Name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,39}$') { throw "Use a short run name such as pr27, not '$Name'." }
    return @{ Root = (Join-Path $script:KitBase $Name); Evidence = (Join-Path $script:KitBase "$Name-evidence") }
}
# Moves an earlier result folder aside, so a repeated phase never mixes old and new results.
function Move-Aside([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) { return $null }
    $Target = $Path + '.previous-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')
    Move-Item -LiteralPath $Path -Destination $Target
    return $Target
}
function Assert-NoKitTask {
    $Running = @(Get-ScheduledTask -TaskName 'VEAcom-*' -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Running' })
    if ($Running.Count) { throw ('A kit task is still running: ' + (($Running | ForEach-Object { $_.TaskName }) -join ', ') + '. Wait for it, or stop it with Stop-ScheduledTask.') }
}
function Start-KitTask([string]$TaskName, [string]$Script, [string]$Arguments, [string]$WorkingDirectory,
        [int]$Minutes, [string]$TaskUser, [string]$TaskFile) {
    $Line = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (Quote-NativeArgument $Script) + ' ' + $Arguments
    $Action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $Line -WorkingDirectory $WorkingDirectory
    $Principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Highest
    $Limit = [TimeSpan]::FromMinutes($Minutes)
    $Remaining = $script:StopDeadline - $script:SafetyMargin - [DateTimeOffset]::UtcNow
    if ($Limit -gt $Remaining) { $Limit = $Remaining }
    $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit $Limit -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Principal $Principal -Settings $Settings | Out-Null
    Save-Json $TaskFile ([ordered]@{ name = $TaskName; user = $TaskUser; launched = [DateTimeOffset]::UtcNow.ToString('o');
        limitMinutes = [Math]::Floor($Limit.TotalMinutes); stopDeadline = $script:StopDeadline.ToString('o') })
    Start-ScheduledTask -TaskName $TaskName
}
# Rejects a malformed plan before anything runs, so the mistake shows in the SSH session and not inside a hidden task.
function Assert-Plan($Config) {
    foreach ($Field in @('Output', 'Root', 'Node', 'Steps')) { if (!(Get-Field $Config $Field)) { throw "The plan has no $Field." } }
    $Seen = @{}
    foreach ($Step in @($Config.Steps)) {
        $StepName = [string](Get-Field $Step 'Name' '')
        if ($StepName -cnotmatch '^[a-z0-9][a-z0-9-]{0,39}$') { throw "Plan step name '$StepName' must be lower-case letters, digits and dashes." }
        if ($Seen.ContainsKey($StepName)) { throw "The plan names $StepName twice." }
        $Seen[$StepName] = $true
        $Arguments = @(Get-Field $Step 'Args' @())
        if (!$Arguments.Count) { throw "Plan step $StepName has no Args." }
        if (($Arguments -join ' ') -match '(?i)(^|\s)--test(\s|$)') {
            throw "Plan step $StepName runs the unit tests. Desktop plans run with only System32 on PATH, where the ISO test cannot start powershell.exe; unit tests run in the hosted Windows job."
        }
        $Minutes = [int](Get-Field $Step 'Minutes' 0)
        if ($Minutes -lt 1 -or $Minutes -gt 30) { throw "Plan step $StepName needs Minutes from 1 to 30." }
        $Variables = Get-Field $Step 'Env'
        if ($Variables) {
            foreach ($Pair in $Variables.PSObject.Properties) {
                if ($script:PlanEnvironment -notcontains $Pair.Name) { throw "Plan step $StepName sets $($Pair.Name); a plan may only set $($script:PlanEnvironment -join ', ')." }
            }
        }
    }
}
function Quote-NativeArgument([string]$Value) {
    if ($Value.Contains("`n") -or $Value.Contains("`r")) { throw 'Multiline process arguments are not supported.' }
    $Escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $Escaped = [regex]::Replace($Escaped, '(\\+)$', '$1$1')
    return '"' + $Escaped + '"'
}
function Invoke-LoggedTool {
    param([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory,
        [string]$OutputDirectory, [int]$TimeoutMinutes = 10, [scriptblock]$OnTick)
    Assert-TimeRemaining
    [IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
    $Started = [DateTimeOffset]::UtcNow
    $Deadline = $Started.AddMinutes($TimeoutMinutes)
    if ($Deadline -gt ($script:StopDeadline - $script:SafetyMargin)) { $Deadline = $script:StopDeadline - $script:SafetyMargin }
    $Stdout = Join-Path $OutputDirectory "$Name.stdout.log"
    $Stderr = Join-Path $OutputDirectory "$Name.stderr.log"
    $Process = $null
    try {
        $ArgumentLine = ($Arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
        if ([IO.Path]::GetFileName($Executable) -ieq 'cmd.exe') {
            if ($Arguments.Count -ne 3 -or $Arguments[0] -ne '/d' -or $Arguments[1] -ne '/c' -or $Arguments[2].Contains('"')) { throw 'Only a direct command-file launch is allowed.' }
            $ArgumentLine='/d /c "'+$Arguments[2]+'"'
        }
        $Process = Start-Process -FilePath $Executable -ArgumentList $ArgumentLine -WorkingDirectory $WorkingDirectory `
            -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru
        [void]$Process.Handle
        while (!$Process.HasExited) {
            if ([DateTimeOffset]::UtcNow -ge $Deadline) { throw "$Name exceeded its time limit." }
            if ($OnTick) { & $OnTick $Process | Out-Null }
            Start-Sleep -Milliseconds 200
            $Process.Refresh()
        }
        if (!$Process.WaitForExit(1000)) { throw "$Name did not finish process cleanup." }
        $Result = [ordered]@{ name=$Name; executable=$Executable; arguments=$Arguments; pid=$Process.Id;
            started=$Started.ToString('o'); finished=[DateTimeOffset]::UtcNow.ToString('o'); exitCode=$Process.ExitCode;
            stdout=$Stdout; stderr=$Stderr }
        Save-Json (Join-Path $OutputDirectory "$Name.process.json") $Result
        if ($Process.ExitCode -ne 0) { throw "$Name failed with exit $($Process.ExitCode). Inspect $Stderr and $Stdout." }
        return $Result
    } catch {
        if ($Process -and !$Process.HasExited) { & "$env:WINDIR\System32\taskkill.exe" /PID $Process.Id /T /F | Out-Null }
        Save-Json (Join-Path $OutputDirectory "$Name.failure.json") @{ name=$Name; error=$_.Exception.Message; finished=[DateTimeOffset]::UtcNow.ToString('o') }
        throw
    }
}
