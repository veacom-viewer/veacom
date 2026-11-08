# Starts build.ps1 for a staged commit as the logged-in user through an interactive scheduled task, so the
# build outlives the SSH session. vm.sh build then waits on status.ps1 -Phase build.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Name, [string]$TaskUser = "$env:COMPUTERNAME\veacom")
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-TimeRemaining 35
$Run = Get-RunPaths $Name
if (!(Test-Path -LiteralPath (Join-Path $Run.Evidence 'stage.json') -PathType Leaf)) { throw "Nothing is staged as $Name; run vm.sh stage first." }
Assert-NoKitTask
$Output = Join-Path $Run.Evidence 'build'
$Previous = Move-Aside $Output
[IO.Directory]::CreateDirectory($Output) | Out-Null
$TaskName = 'VEAcom-Build-' + $Name + '-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')
Start-KitTask -TaskName $TaskName -Script (Join-Path $PSScriptRoot 'build.ps1') -Arguments ('-Name ' + $Name) `
    -WorkingDirectory $Run.Root -Minutes 120 -TaskUser $TaskUser -TaskFile (Join-Path $Output 'task.json')
if ($Previous) { Write-Output "The earlier build's results are in $Previous." }
Write-Output "Started $TaskName."
