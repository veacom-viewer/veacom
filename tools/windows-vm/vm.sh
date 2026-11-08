#!/usr/bin/env bash
# Runs the Tesla T4 checks for a commit on the Windows VM, from a Mac or Linux checkout of this repository.
# tools/windows-vm/README.md explains the sequence, the fixed stop deadline and what is not covered.
#
#   vm.sh start [minutes]        Set a fixed GCP stop time (default 90 minutes ahead) and start the VM. Costs money.
#   vm.sh tunnel                 Open the IAP tunnel to the VM's SSH port in the background.
#   vm.sh run <name> [ref]       stage, build, checks and collect in one go.
#   vm.sh stage <name> [ref]     Upload `git archive` of the commit (default HEAD) and stage it as C:\veacom\<name>.
#   vm.sh build <name>           Build the staged commit on the VM and wait for the result.
#   vm.sh checks <name>          Run the T4 plan in the VM's desktop session and wait for the result.
#   vm.sh status <name>          Print every phase once.
#   vm.sh collect <name> [dir]   Zip the evidence on the VM, download it (default test-results/windows-vm) and check it.
#   vm.sh stop <name>            Clean up on the VM, stop it, confirm TERMINATED and close the tunnel.
#
# Needs gcloud signed in to the VM's project. The VM is named in ~/.config/veacom/vm.env (or the file in
# VEACOM_VM_CONFIG), outside the repository, as KEY=value lines; the same names in the environment win:
#   VEACOM_VM_PROJECT, VEACOM_VM_ZONE, VEACOM_VM_INSTANCE   the VM (required)
#   VEACOM_VM_SSH_KEY, VEACOM_VM_KNOWN_HOSTS                its private key and host-key file (required)
#   VEACOM_VM_ACCOUNT, VEACOM_VM_PORT                       gcloud account, local tunnel port (default 22338)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
config=${VEACOM_VM_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/veacom/vm.env}
setting_pattern='^(VEACOM_VM_[A-Z_]+)=(.*)$'
gcp_pattern='^[a-z][a-z0-9-]{0,62}$'
port_pattern='^[0-9]{4,5}$'

die() { printf 'vm.sh: %s\n' "$*" >&2; exit 1; }
note() { printf 'vm.sh: %s\n' "$*" >&2; }

# Reads the settings file without running it: only known KEY=value lines, surrounding quotes and a leading
# ~/ allowed. A setting already in the environment is kept.
load_config() {
  local line key value
  [ -f "$config" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case $line in '' | '#'*) continue ;; esac
    [[ $line =~ $setting_pattern ]] || die "$config: cannot read '$line'; write KEY=value lines"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    case $key in
      VEACOM_VM_PROJECT | VEACOM_VM_ZONE | VEACOM_VM_INSTANCE | VEACOM_VM_SSH_KEY | VEACOM_VM_KNOWN_HOSTS | VEACOM_VM_ACCOUNT | VEACOM_VM_PORT) ;;
      *) die "$config: unknown setting $key" ;;
    esac
    case $value in \"*\" | \'*\') value=${value:1:${#value}-2} ;; esac
    case $value in \~/*) value="$HOME/${value:2}" ;; esac
    [ -n "${!key:-}" ] || printf -v "$key" '%s' "$value"
  done <"$config"
}
load_config
instance=${VEACOM_VM_INSTANCE:-}
project=${VEACOM_VM_PROJECT:-}
zone=${VEACOM_VM_ZONE:-}
port=${VEACOM_VM_PORT:-22338}
[[ $port =~ $port_pattern ]] || die "VEACOM_VM_PORT must be a port number, not '$port'"
login=veacom@127.0.0.1
base='C:\veacom'
state="${TMPDIR:-/tmp}/veacom-vm-$port"
name_pattern='^[A-Za-z0-9][A-Za-z0-9-]{0,39}$'
time_pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
switch_pattern='^-[A-Za-z][A-Za-z0-9]*$'
value_pattern='^[A-Za-z0-9_.:+/][A-Za-z0-9_.:+/\-]*$'

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

gc() {
  if [ -n "${VEACOM_VM_ACCOUNT:-}" ]; then gcloud "$@" --account "$VEACOM_VM_ACCOUNT"; else gcloud "$@"; fi
}
vm_ready() {
  local setting
  for setting in VEACOM_VM_PROJECT VEACOM_VM_ZONE VEACOM_VM_INSTANCE; do
    [ -n "${!setting:-}" ] || die "set $setting in $config (see tools/windows-vm/README.md)"
    [[ ${!setting} =~ $gcp_pattern ]] || die "$setting is '${!setting}', which is not a Google Cloud name"
  done
}
instance_cmd() {
  local verb=$1
  shift
  vm_ready
  gc compute instances "$verb" "$instance" --project "$project" --zone "$zone" "$@"
}
instance_value() { instance_cmd describe --format="value($1)"; }

check_name() { [[ $1 =~ $name_pattern ]] || die "use a short run name such as pr27, not '$1'"; }
kit() { printf '%s\\%s\\tools\\windows-vm' "$base" "$1"; }

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}
utc_in() {
  date -u -v+"$1"M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+$1 minutes" +%Y-%m-%dT%H:%M:%SZ
}

ssh_ready() {
  [ -n "${VEACOM_VM_SSH_KEY:-}" ] && [ -f "$VEACOM_VM_SSH_KEY" ] || die "set VEACOM_VM_SSH_KEY in $config to the VM's private key"
  [ -n "${VEACOM_VM_KNOWN_HOSTS:-}" ] && [ -f "$VEACOM_VM_KNOWN_HOSTS" ] || die "set VEACOM_VM_KNOWN_HOSTS in $config to the file holding the VM's host key"
  ssh_opts=(-i "$VEACOM_VM_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$VEACOM_VM_KNOWN_HOSTS" -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
}

# Runs one kit script on the VM. Only an invocation line travels, as -EncodedCommand (which works whatever
# shell sshd starts), and the script runs from its file, so its param() block and $PSScriptRoot work. Nothing
# is prepended to a script's text. Arguments are limited to characters that need no quoting. A parameter name such as
# -Sha256 goes bare, and a value may not start with a dash, so one is never taken for the other. The VM's sshd
# starts Windows PowerShell, which turns any failure into exit 1; 255 means SSH itself failed.
remote() {
  local script=$1 line arg encoded
  shift
  # Progress records would otherwise reach stderr as CLIXML on every call.
  line="\$ProgressPreference = 'SilentlyContinue'; & '$script'"
  for arg in "$@"; do
    if [[ $arg =~ $switch_pattern ]]; then line="$line $arg"
    elif [[ $arg =~ $value_pattern ]]; then line="$line '$arg'"
    else die "refusing to pass '$arg' to the VM"; fi
  done
  line="$line; exit \$LASTEXITCODE"
  encoded=$(printf '%s' "$line" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')
  ssh -n -p "$port" "${ssh_opts[@]}" "$login" "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
}
upload() { scp -q -P "$port" "${ssh_opts[@]}" "$1" "$login:$2"; }
download() { scp -q -P "$port" "${ssh_opts[@]}" "$login:$1" "$2"; }

# The fixed stop time comes from the instance itself, never from this computer's clock.
instance_deadline() {
  local status deadline
  status=$(instance_value status) || die "could not read $instance with gcloud"
  [ "$status" = RUNNING ] || die "$instance is $status, not RUNNING"
  deadline=$(instance_value scheduling.terminationTime)
  [ -n "$deadline" ] || die "$instance has no fixed stop time; stop it and start it again with: tools/windows-vm/vm.sh start"
  [[ $deadline =~ $time_pattern ]] || die "unexpected terminationTime '$deadline'"
  printf '%s\n' "$deadline"
}

# Waits for one phase. Any state other than running ends the wait at once; SSH may drop twice in a row.
wait_phase() {
  local name=$1 phase=$2 minutes=$3 until out rc state shown='' drops=0
  until=$(( $(date +%s) + minutes * 60 ))
  while :; do
    rc=0
    out=$(remote "$(kit "$name")\\status.ps1" -Name "$name" -Phase "$phase" 2>&1 | LC_ALL=C tr -d '\r') || rc=$?
    if [ "$rc" -eq 255 ]; then
      drops=$((drops + 1))
      [ "$drops" -lt 3 ] || die "lost SSH three times; the task keeps running on the VM. Check it with: tools/windows-vm/vm.sh status $name"
      note "SSH failed ($drops of 3); trying again"
      sleep 20
      continue
    fi
    drops=0
    state=$(printf '%s\n' "$out" | sed -n 's/^VEACOM-STATUS: //p' | tail -1)
    case $state in
      running)
        if [ "$out" != "$shown" ]; then printf '%s\n' "$out" | grep -v '^VEACOM-STATUS: ' || true; shown=$out; fi
        [ "$(date +%s)" -lt "$until" ] || die "$phase is still running after $minutes minutes"
        sleep 20 ;;
      passed) printf '%s\n' "$out" | grep -v '^VEACOM-STATUS: ' || true; return 0 ;;
      failed) printf '%s\n' "$out" | grep -v '^VEACOM-STATUS: ' || true; note "$phase failed"; return 1 ;;
      *) printf '%s\n' "$out" >&2; die "status for $phase reported '${state:-nothing}' (exit $rc)" ;;
    esac
  done
}

cmd_start() {
  local minutes=${1:-90} status deadline try
  [[ $minutes =~ ^[0-9]+$ ]] && [ "$minutes" -ge 30 ] && [ "$minutes" -le 240 ] || die 'give the session length in minutes, 30 to 240'
  status=$(instance_value status) || die "could not read $instance with gcloud"
  case $status in
    TERMINATED|STOPPED) ;;
    *) die "$instance is $status; its fixed stop time stays $(instance_value scheduling.terminationTime)" ;;
  esac
  deadline=$(utc_in "$minutes")
  instance_cmd set-scheduling --termination-time="$deadline" --instance-termination-action=STOP || die 'could not set the fixed stop time'
  [ "$(instance_value scheduling.instanceTerminationAction)" = STOP ] || die "$instance would not stop at its deadline"
  note "fixed stop time $(instance_value scheduling.terminationTime)"
  mkdir -p "$state"
  for try in 1 2 3 4 5 6 7 8; do
    if instance_cmd start --quiet 2>"$state/start.err"; then note "started; open the tunnel next: tools/windows-vm/vm.sh tunnel"; return 0; fi
    tail -2 "$state/start.err" >&2
    grep -Eq 'RESOURCE_POOL_EXHAUSTED|resources available|does not have enough resources' "$state/start.err" || die 'start failed'
    note "no T4 free in $zone (try $try of 8); trying again in a minute"
    sleep 60
  done
  die "no T4 free in $zone after 8 tries"
}

tunnel_open() { (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; }
cmd_tunnel() {
  local _
  if tunnel_open; then note "something already listens on localhost:$port"; return 0; fi
  vm_ready
  mkdir -p "$state"
  if [ -n "${VEACOM_VM_ACCOUNT:-}" ]; then
    nohup gcloud compute start-iap-tunnel "$instance" 22 --local-host-port="localhost:$port" --project "$project" --zone "$zone" \
      --account "$VEACOM_VM_ACCOUNT" >"$state/tunnel.log" 2>&1 &
  else
    nohup gcloud compute start-iap-tunnel "$instance" 22 --local-host-port="localhost:$port" --project "$project" --zone "$zone" \
      >"$state/tunnel.log" 2>&1 &
  fi
  echo $! >"$state/tunnel.pid"
  for _ in $(seq 1 30); do
    if tunnel_open; then note "tunnel open on localhost:$port (pid $(cat "$state/tunnel.pid"))"; return 0; fi
    sleep 1
  done
  die "the tunnel did not open; see $state/tunnel.log"
}

cmd_stage() {
  local name=$1 ref=${2:-HEAD} commit deadline work sha
  check_name "$name"
  commit=$(git -C "$repo" rev-parse --verify --quiet "$ref^{commit}") || die "no commit '$ref'"
  if [ "$ref" = HEAD ] && [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ]; then
    die 'the checkout has uncommitted changes, which git archive leaves out; commit them or name a ref'
  fi
  git -C "$repo" cat-file -e "$commit:tools/windows-vm/stage.ps1" 2>/dev/null || die "$commit has no tools/windows-vm/stage.ps1; merge main into the branch first"
  ssh_ready
  deadline=$(instance_deadline)
  work=$(mktemp -d "${TMPDIR:-/tmp}/veacom-vm-stage.XXXXXX")
  git -C "$repo" archive --format=zip -o "$work/source.zip" "$commit"
  unzip -p "$work/source.zip" tools/windows-vm/stage.ps1 >"$work/stage.ps1"
  sha=$(sha256 "$work/source.zip")
  note "staging $commit as $name: archive SHA-256 $sha, fixed stop time $deadline"
  upload "$work/source.zip" "C:/veacom/$name.source.zip" || die 'could not upload the archive; is the tunnel open?'
  upload "$work/stage.ps1" "C:/veacom/$name.stage.ps1" || die 'could not upload stage.ps1'
  rm -rf "$work"
  remote "$base\\$name.stage.ps1" -Name "$name" -Archive "$base\\$name.source.zip" -Sha256 "$sha" -Commit "$commit" -StopDeadline "$deadline" \
    || die 'staging failed on the VM (see above)'
}

cmd_build() {
  check_name "$1"
  ssh_ready
  remote "$(kit "$1")\\launch-build.ps1" -Name "$1" || die 'could not start the build (see above)'
  wait_phase "$1" build 130
}

cmd_checks() {
  check_name "$1"
  ssh_ready
  remote "$(kit "$1")\\launch-checks.ps1" -Name "$1" || die 'could not start the T4 checks (see above)'
  wait_phase "$1" t4 70
}

cmd_status() {
  local rc=0
  check_name "$1"
  ssh_ready
  remote "$(kit "$1")\\status.ps1" -Name "$1" -Phase all | LC_ALL=C tr -d '\r' || rc=$?
  return "$rc"
}

cmd_collect() {
  local name=$1 dest=${2:-$repo/test-results/windows-vm} out line bytes sha commit zip local_zip
  check_name "$name"
  ssh_ready
  out=$(remote "$(kit "$name")\\collect.ps1" -Name "$name" | LC_ALL=C tr -d '\r') || die 'collect.ps1 failed on the VM (see above)'
  printf '%s\n' "$out" | grep -v '^EVIDENCE-ZIP: ' || true
  line=$(printf '%s\n' "$out" | sed -n 's/^EVIDENCE-ZIP: //p' | tail -1)
  [ -n "$line" ] || die 'collect.ps1 reported no evidence zip'
  read -r bytes sha commit zip <<EOF
$line
EOF
  mkdir -p "$dest"
  local_zip="$dest/$name-${commit:0:12}-t4.zip"
  download "${zip//\\//}" "$local_zip" || die 'could not download the evidence'
  [ "$(sha256 "$local_zip")" = "$sha" ] || die "$local_zip does not match the SHA-256 reported on the VM"
  note "evidence: $local_zip ($bytes bytes, SHA-256 $sha)"
}

cmd_run() {
  local name=$1 result=0
  cmd_stage "$name" "${2:-HEAD}"
  cmd_build "$name" || result=1
  cmd_checks "$name" || result=1
  cmd_collect "$name"
  return "$result"
}

cmd_stop() {
  local name=${1:-} status pid
  if [ -n "$name" ]; then
    check_name "$name"
    ssh_ready
    remote "$(kit "$name")\\cleanup.ps1" | LC_ALL=C tr -d '\r' || note 'cleanup on the VM reported a problem (above); deal with it before the next session'
  else
    note 'no run name given, so the VM was not cleaned up (finished tasks, T4 state)'
  fi
  instance_cmd stop --quiet || die "could not stop $instance; stop it in the console now"
  status=$(instance_value status)
  [ "$status" = TERMINATED ] || die "$instance is $status after stopping; check it in the console"
  if [ -f "$state/tunnel.pid" ]; then
    pid=$(cat "$state/tunnel.pid")
    kill "$pid" 2>/dev/null || true
    rm -f "$state/tunnel.pid"
  fi
  sleep 1
  if tunnel_open; then die "$instance is TERMINATED, but something still listens on localhost:$port; close that tunnel"; fi
  note "$instance is TERMINATED and the tunnel is closed"
}

command=${1:-help}
[ $# -gt 0 ] && shift
case $command in start | tunnel | stage | run | stop) vm_ready ;; esac
case $command in
  start) cmd_start "$@" ;;
  tunnel) cmd_tunnel ;;
  stage|build|checks|status|collect|run)
    [ $# -ge 1 ] || { usage >&2; exit 2; }
    "cmd_$command" "$@" ;;
  stop) cmd_stop "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
