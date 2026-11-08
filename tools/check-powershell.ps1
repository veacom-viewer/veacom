# Parses every tracked PowerShell script and rejects what Windows PowerShell 5.1 cannot run. 5.1 runs them on
# the Windows VM and on Windows PCs, while this check also runs under PowerShell 7 on macOS and Linux, whose
# parser accepts more. It reports syntax errors, PowerShell 7 operators (?:, ??, ??=, ?., &&, ||), the
# PowerShell 7 platform variables, a few parameters added after 5.1, (command).Count, which 5.1's strict mode
# rejects when the command returns one item or none, and non-ASCII characters: 5.1 reads a script without a
# byte-order mark as ANSI, where the bytes of a UTF-8 dash can turn into a closing quote.
#
#   pwsh -NoProfile -File tools/check-powershell.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Repository = Split-Path -Parent $PSScriptRoot
$Listed = (& git -C $Repository ls-files -z -- '*.ps1' '*.psm1' | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed.' }
$Files = @($Listed.Split([char]0) | Where-Object { $_.Trim() })
$Newer = @{
    'ConvertFrom-Json' = @('AsHashtable', 'Depth', 'NoEnumerate'); 'ConvertTo-Json' = @('EnumsAsStrings', 'AsArray')
    'Get-Content' = @('AsByteStream'); 'Set-Content' = @('AsByteStream', 'NoNewline'); 'Add-Content' = @('AsByteStream')
    'ForEach-Object' = @('Parallel', 'ThrottleLimit'); 'Join-Path' = @('AdditionalChildPath')
    'Invoke-WebRequest' = @('SkipCertificateCheck', 'SkipHttpErrorCheck', 'StatusCodeVariable', 'Authentication', 'Token')
    'Invoke-RestMethod' = @('SkipCertificateCheck', 'SkipHttpErrorCheck', 'StatusCodeVariable', 'Authentication', 'Token')
    'Start-Process' = @('Environment'); 'Select-String' = @('Raw', 'NoEmphasis'); 'Get-ChildItem' = @('FollowSymlink')
}
$NewerCommands = @('Test-Json', 'Get-Error', 'ConvertFrom-Markdown', 'Join-String', 'Remove-Alias', 'Get-Uptime')
$Problems = New-Object System.Collections.Generic.List[string]
foreach ($Relative in $Files) {
    $Path = Join-Path $Repository $Relative
    $Text = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($Path))
    $Odd = [regex]::Match($Text, '[^\x09\x0a\x0d\x20-\x7e]')
    if ($Odd.Success) {
        $Line = ($Text.Substring(0, $Odd.Index) -split "`n").Count
        $Problems.Add("${Relative}:${Line}: non-ASCII character 0x{0:x2}; keep PowerShell scripts ASCII." -f [int][char]$Odd.Value)
    }
    $Tokens = $null; $Errors = $null
    $Ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$Tokens, [ref]$Errors)
    foreach ($ParseError in $Errors) { $Problems.Add("${Relative}:$($ParseError.Extent.StartLineNumber): $($ParseError.Message)") }
    $Found = $Ast.FindAll({
        param($Node)
        $Type = $Node.GetType().Name
        if ($Type -eq 'TernaryExpressionAst' -or $Type -eq 'PipelineChainAst') { return $true }
        if ($Type -eq 'BinaryExpressionAst' -and [string]$Node.Operator -eq 'QuestionQuestion') { return $true }
        if ($Type -eq 'AssignmentStatementAst' -and [string]$Node.Operator -eq 'QuestionQuestionEquals') { return $true }
        if ($Node.PSObject.Properties['NullConditional'] -and $Node.NullConditional) { return $true }
        if ($Type -eq 'VariableExpressionAst' -and @('IsWindows', 'IsLinux', 'IsMacOS', 'IsCoreCLR') -contains $Node.VariablePath.UserPath) { return $true }
        # (Get-Thing).Count: a command that returns no item or one gives $null or that item, and under strict
        # mode 5.1 has no .Count on them, though PowerShell 7 does. @(Get-Thing).Count always works.
        if ($Type -eq 'MemberExpressionAst' -and $Node.Expression.GetType().Name -eq 'ParenExpressionAst' -and
            $Node.Member.Extent.Text -eq 'Count' -and
            $Node.Expression.Find({ param($Inner) $Inner.GetType().Name -eq 'CommandAst' }, $true)) { return $true }
        if ($Type -eq 'CommandAst') {
            $Command = $Node.GetCommandName()
            if ($Command -and $NewerCommands -contains $Command) { return $true }
            if ($Command -and $Newer.ContainsKey($Command)) {
                foreach ($Element in $Node.CommandElements) {
                    if ($Element.GetType().Name -eq 'CommandParameterAst' -and $Newer[$Command] -contains $Element.ParameterName) { return $true }
                }
            }
            if ($Command -eq 'Join-Path') {
                $Positional = @($Node.CommandElements | Select-Object -Skip 1 | Where-Object { $_.GetType().Name -ne 'CommandParameterAst' })
                $Named = @($Node.CommandElements | Where-Object { $_.GetType().Name -eq 'CommandParameterAst' })
                if (!$Named.Count -and $Positional.Count -gt 2) { return $true }
            }
        }
        return $false
    }, $true)
    foreach ($Node in $Found) {
        $Snippet = $Node.Extent.Text -replace '\s+', ' '
        if ($Snippet.Length -gt 60) { $Snippet = $Snippet.Substring(0, 60) + '...' }
        $Why = 'Windows PowerShell 5.1 cannot run'
        if ($Node.GetType().Name -eq 'MemberExpressionAst') { $Why = 'Windows PowerShell 5.1 strict mode fails on no result or one; write @(...)' }
        $Problems.Add("${Relative}:$($Node.Extent.StartLineNumber): ${Why}: $Snippet")
    }
}
if ($Problems.Count) {
    foreach ($Problem in $Problems) { [Console]::Error.WriteLine($Problem) }
    exit 1
}
Write-Output "PASS PowerShell 5.1 syntax and compatibility ($($Files.Count) scripts)"
