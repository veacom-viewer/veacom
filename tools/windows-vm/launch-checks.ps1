# Writes the T4 plan for a built commit and starts it with launch-fallback.ps1 in the desktop session. These
# are the checks the hosted Windows job cannot run: drawing on the Tesla T4 (packaged smoke, hardware
# rendering, GPU startup, the padding pixels, the video encoder with the GPU on), the click budgets, which
# accept only the fingerprinted ct-small, and real Windows mouse input on the frameless window.
# A check whose tool is not in the commit, or whose build step failed, is recorded as skipped with the reason.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Name,
    [string]$Tools = 'C:\veacom\migration-tools',
    [string]$Study = 'C:\veacom\bench-data\studies\ct-small')
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-TimeRemaining 15
$Run = Get-RunPaths $Name
$BuildFile = Join-Path $Run.Evidence 'build\build.json'
if (!(Test-Path -LiteralPath $BuildFile -PathType Leaf)) { throw "$Name has not been built; run vm.sh build first." }
$Build = Read-Json $BuildFile
if ($Build.status -eq 'running') { throw "The build of $Name is still running." }
$Passed = @(@($Build.steps) | Where-Object { $_ -and $_.status -eq 'passed' } | ForEach-Object { $_.name })
$Output = Join-Path $Run.Evidence 't4'
$Previous = Move-Aside $Output
$Series = Join-Path $Study 'S01'
$Packaged = Join-Path $Run.Root 'release-electron\win-unpacked\VEAcom Electron.exe'
$OnPackage = @('pnpm-install', 'package')
$OnSource = @('pnpm-install', 'setup-runtime', 'native-build', 'web-build')
$script:Steps = @()
function Add-Check([string]$StepName, [string[]]$Arguments, [string[]]$Needs, [int]$Minutes, [bool]$UsePackage = $false) {
    $Step = [ordered]@{ Name = $StepName; Args = $Arguments; Minutes = $Minutes; Env = @{} }
    if ($UsePackage) { $Step.Env = @{ VEACOM_SMOKE_EXECUTABLE = $Packaged } }
    $Missing = @($Needs | Where-Object { $Passed -notcontains $_ })
    if (!(Test-Path -LiteralPath (Join-Path $Run.Root $Arguments[0]) -PathType Leaf)) { $Step.Skip = "$($Arguments[0]) is not in this commit" }
    elseif ($Missing.Count) { $Step.Skip = 'the build did not pass ' + ($Missing -join ', ') }
    $script:Steps += $Step
}
Add-Check 'video-encoder' @('tools\check-video-encoder.cjs', (Join-Path $Output 'video-encoder')) @('pnpm-install') 5
Add-Check 'native-texture' @('tools\check-native-presentation.cjs', $Packaged, 'bitmap') $OnPackage 4
Add-Check 'native-views' @('tools\check-native-views.cjs') $OnPackage 6 $true
Add-Check 'desktop-smoke' @('tools\desktop-smoke.cjs', $Series, (Join-Path $Output 'desktop-smoke')) $OnPackage 8 $true
Add-Check 'click-budget' @('tools\check-click-budget.cjs', $Study, (Join-Path $Output 'click-budget')) $OnPackage 12 $true
Add-Check 'budget-coverage' @('tools\check-budget-coverage.cjs', $Output) $OnPackage 2
Add-Check 'hardware-rendering' @('tools\check-software-rendering.cjs', $Series, (Join-Path $Output 'hardware-rendering'), '--expect', 'hardware') $OnPackage 6 $true
Add-Check 'padding-t4' @('tools\check-padding-gpu.mjs', (Join-Path $Output 'padding'), 't4') $OnPackage 8 $true
Add-Check 'gpu-startup' @('tools\check-gpu-startup.cjs', $Study, (Join-Path $Output 'gpu-startup.json')) $OnSource 6
Add-Check 'ui-windows' @('tools\windows-vm\ui-windows-checks.cjs', $Packaged, $Study, (Join-Path $Output 'ui-windows')) $OnPackage 8
$PlanFile = Join-Path $Output 'plan.json'
Save-Json $PlanFile ([ordered]@{ Output = $Output; Root = $Run.Root; Node = (Join-Path $Tools 'node\node.exe'); RequireGpu = $true; Steps = $script:Steps })
if ($Previous) { Write-Output "The earlier T4 results are in $Previous." }
& (Join-Path $PSScriptRoot 'launch-fallback.ps1') -Plan $PlanFile
