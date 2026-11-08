# Reports a commit's run on the VM: one phase (stage, build or t4) or all of them. The last line is
# "VEACOM-STATUS: <state>", which vm.sh waits on. State is running, passed, failed or error; "all" can also be
# incomplete. A phase is an error, not "running", when it has no result and no task is running for it, or its
# task ended while its result still says running, so a wait loop stops at once instead of running to its limit.
# Exit codes: 0 passed, 1 failed, 2 running, 3 error or incomplete.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Name, [ValidateSet('stage', 'build', 't4', 'all')][string]$Phase = 'all')
. (Join-Path $PSScriptRoot 'Common.ps1')
$Run = Get-RunPaths $Name
$Now = [DateTimeOffset]::UtcNow

function Get-Seconds($Entry) {
    $Started = Get-Field $Entry 'started'; $Finished = Get-Field $Entry 'finished'
    if (!$Started) { return '' }
    $End = if ($Finished) { [DateTimeOffset]::Parse([string]$Finished, [Globalization.CultureInfo]::InvariantCulture) } else { $Now }
    return ('{0:0}s' -f ($End - [DateTimeOffset]::Parse([string]$Started, [Globalization.CultureInfo]::InvariantCulture)).TotalSeconds)
}
function Write-Tail([string]$Folder, [string]$StepName) {
    foreach ($Log in @("$StepName.stderr.log", "$StepName.stdout.log")) {
        $File = Join-Path $Folder $Log
        if ((Test-Path -LiteralPath $File) -and (Get-Item -LiteralPath $File).Length) {
            Get-Content -LiteralPath $File -Tail 6 | ForEach-Object { "      | $_" }
            return
        }
    }
}
function Write-Steps($Document, [string]$Folder) {
    foreach ($Step in @(Get-Field $Document 'steps' @())) {
        if (!$Step) { continue }
        $State = [string](Get-Field $Step 'status' (Get-Field $Step 'exitCode' '?'))
        $Note = [string](Get-Field $Step 'reason' (Get-Field $Step 'error' ''))
        '    {0,-8} {1,-22} {2,6}  {3}' -f $State, $Step.name, (Get-Seconds $Step), $Note
        if ($State -eq 'failed') { Write-Tail $Folder $Step.name }
    }
    $Current = Get-Field $Document 'current'
    if ($Current) { "    running  $Current" }
}
# Reads the task's state before the result: a runner writes its final result before its task leaves Running.
function Get-PhaseState([string]$Folder, [string]$ResultName) {
    $TaskFile = Join-Path $Folder 'task.json'
    $Task = if (Test-Path -LiteralPath $TaskFile) { Read-Json $TaskFile } else { $null }
    $TaskState = 'missing'; $LastResult = ''
    if ($Task) {
        $Scheduled = Get-ScheduledTask -TaskName $Task.name -ErrorAction SilentlyContinue
        if ($Scheduled) {
            $TaskState = [string]$Scheduled.State
            $LastResult = '0x{0:X}' -f (Get-ScheduledTaskInfo -TaskName $Task.name).LastTaskResult
        }
    }
    $Active = $TaskState -eq 'Running' -or $TaskState -eq 'Queued'
    $File = Join-Path $Folder $ResultName
    $Document = $null; $Unreadable = $null
    if (Test-Path -LiteralPath $File) { try { $Document = Read-Json $File } catch { $Unreadable = $_.Exception.Message } }
    $Why = ''
    if ($Document) {
        $Status = [string](Get-Field $Document 'status' '')
        if ($Status -eq 'passed' -or $Status -eq 'failed') { $State = $Status }
        elseif ($Active) { $State = 'running' }
        else { $State = 'error'; $Why = "task $($Task.name) is $TaskState (last result $LastResult) but $ResultName still says '$Status': the runner stopped without finishing. Read the logs in $Folder." }
    } elseif (!$Task) { $State = 'error'; $Why = 'not started' }
    elseif ($Active -or $Unreadable) { $State = 'running'; $Why = 'starting' }
    elseif (($Now - [DateTimeOffset]::Parse([string]$Task.launched, [Globalization.CultureInfo]::InvariantCulture)).TotalSeconds -lt 90) { $State = 'running'; $Why = 'starting' }
    else { $State = 'error'; $Why = "no $ResultName 90 s after $($Task.name) started; the task is $TaskState (last result $LastResult). Run the script by hand in the desktop session to see why." }
    return @{ State = $State; Why = $Why; Document = $Document }
}

$States = @{}
$Lines = New-Object System.Collections.Generic.List[string]
if ($Phase -eq 'stage' -or $Phase -eq 'all') {
    $StageFile = Join-Path $Run.Evidence 'stage.json'
    if (Test-Path -LiteralPath $StageFile) {
        $Stage = Read-Json $StageFile
        $States.stage = [string]$Stage.status
        $Lines.Add("stage    $($Stage.status)  commit $($Stage.commit)  archive $($Stage.archiveSha256.Substring(0, 12))  staged $($Stage.staged)")
    } else { $States.stage = 'error'; $Lines.Add("stage    error  nothing is staged as $Name") }
}
foreach ($Pair in @(@('build', 'build', 'build.json'), @('t4', 't4', 'fallback.json'))) {
    if ($Phase -ne $Pair[0] -and $Phase -ne 'all') { continue }
    $Folder = Join-Path $Run.Evidence $Pair[1]
    $Found = Get-PhaseState $Folder $Pair[2]
    if ($Phase -eq 'all' -and $Found.Why -eq 'not started') { $States[$Pair[0]] = 'incomplete'; $Lines.Add(('{0,-8} not started' -f $Pair[0])); continue }
    $States[$Pair[0]] = $Found.State
    $Detail = (@($Found.Why, (Get-Field $Found.Document 'error' '')) | Where-Object { $_ }) -join '  '
    $Lines.Add(('{0,-8} {1}  {2}' -f $Pair[0], $Found.State, $Detail))
    if ($Found.Document) {
        foreach ($Line in @(Write-Steps $Found.Document $Folder)) { $Lines.Add($Line) }
        foreach ($Warning in @(Get-Field $Found.Document 'warnings' @())) { if ($Warning) { $Lines.Add("    warning  $Warning") } }
    }
}
$Left = [Math]::Floor(($script:StopDeadline - $Now).TotalMinutes)
$Lines.Add("deadline $($script:StopDeadline.ToString('yyyy-MM-ddTHH:mm:ssZ')) ($Left min left, work stops 5 min before)")
if ($Left -lt 5) { $States.deadline = 'error'; $Lines.Add('error    the fixed stop deadline is too close or has passed; stop the VM') }

$Values = @($States.Values)
$Overall = if ($Values -contains 'error') { 'error' } elseif ($Values -contains 'running') { 'running' } elseif ($Values -contains 'failed') { 'failed' } elseif ($Values -contains 'incomplete') { 'incomplete' } else { 'passed' }
foreach ($Line in $Lines) { Write-Output $Line }
Write-Output "VEACOM-STATUS: $Overall"
exit @{ passed = 0; failed = 1; running = 2; error = 3; incomplete = 3 }[$Overall]
