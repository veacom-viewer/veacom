#!/usr/bin/env bash
# Checks vm.sh's invocation line without a VM. remote() is run with ssh replaced by a local PowerShell that
# decodes the same -EncodedCommand and runs a stand-in script with stage.ps1's parameters. Each parameter
# must bind by name. A name with digits, such as -Sha256, once went across as a quoted value and was bound
# by position instead.
#
#   tools/windows-vm/check-vm-sh.sh        (needs bash and pwsh; CI runs it on Linux)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat >"$work/stand-in.ps1" <<'EOF'
param([Parameter(Mandatory=$true)][string]$Name, [string]$Archive, [string]$Sha256, [string]$Commit, [string]$StopDeadline, [string]$Phase)
"Name=$Name|Archive=$Archive|Sha256=$Sha256|Commit=$Commit|StopDeadline=$StopDeadline|Phase=$Phase"
exit 2
EOF

# vm.sh with no settings file and the help command only defines its functions and prints its usage.
set -- help
# shellcheck source=tools/windows-vm/vm.sh
HOME="$work" source "$here/vm.sh" >/dev/null
# shellcheck disable=SC2034 # read by remote()
ssh_opts=(-x)
ssh() { local last=${!#}; pwsh -NoProfile -NonInteractive -EncodedCommand "${last##*-EncodedCommand }"; }

failures=0
expect() {
  if [ "$2" = "$3" ]; then printf 'PASS %s\n' "$1"; else printf 'FAIL %s\n  expected: %s\n  got:      %s\n' "$1" "$3" "$2"; failures=$((failures + 1)); fi
}
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
commit=0123456789abcdef0123456789abcdef01234567
set +e
got=$(remote "$work/stand-in.ps1" -Name pr27 -Archive 'C:/veacom/pr27.source.zip' -Sha256 "$sha" -Commit "$commit" -StopDeadline 2026-11-07T17:00:00Z | tr -d '\r')
rc=$?
set -e
expect 'stage arguments bind by name, -Sha256 included' "$got" "Name=pr27|Archive=C:/veacom/pr27.source.zip|Sha256=$sha|Commit=$commit|StopDeadline=2026-11-07T17:00:00Z|Phase="
expect "the script's exit code comes back" "$rc" 2
got=$( (remote "$work/stand-in.ps1" -Name pr27 -Phase '-1') 2>&1 ) || true
expect 'a value that starts with a dash is refused' "$got" "vm.sh: refusing to pass '-1' to the VM"
got=$( (remote "$work/stand-in.ps1" -Name 'pr 27') 2>&1 ) || true
expect 'a value that needs quoting is refused' "$got" "vm.sh: refusing to pass 'pr 27' to the VM"
[ "$failures" -eq 0 ] || exit 1
