#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 2 ]; then echo 'Usage: tools/verify.sh <synthetic-ct-small> <evidence-directory>' >&2; exit 2; fi
study=$(cd "$1" && pwd)
mkdir -p "$2"
parent=$(cd "$2" && pwd)
out=$(mktemp -d "$parent/run-XXXXXXXX")
cd "$(dirname "$0")/.."
echo "Verification evidence: $out"
run() {
  local name=$1; shift
  if "$@" >"$out/$name.log" 2>&1; then
    echo "PASS $name" | tee -a "$out/summary.log"
  else
    local status=$?
    echo "FAIL $name ($status)" | tee -a "$out/summary.log" >&2
    tail -50 "$out/$name.log" >&2
    if [ "$name" = export-diff ] && [ -f "$out/export/renderer.json" ]; then
      cat "$out/export/renderer.json" >&2
    fi
    return "$status"
  fi
}
run repository node tools/check-repository.mjs
run fixture node tools/check-golden-study.mjs "$study"
run react-memo node tools/check-react-memo.mjs
run lint node tools/pinned-tool.mjs oxlint
run workflows node tools/pinned-tool.mjs actionlint
series="$study/S01"
run runtime pnpm run setup:runtime
run core-build pnpm run build:core
run core-tests cargo test --release --locked --manifest-path native/Cargo.toml
run core-clippy cargo clippy --release --locked --all-targets --manifest-path native/Cargo.toml -- -D warnings
run open-work node tools/check-open-speed.cjs --output="$out/open-work"
run unit pnpm test
run web-build pnpm run build:web
run desktop-smoke node tools/desktop-smoke.cjs "$series" "$out/desktop-smoke"
run video-encoder node tools/check-video-encoder.cjs "$out/video-encoder"
run video-encoder-no-gpu node tools/check-video-encoder.cjs "$out/video-encoder" --no-gpu
run click-budget node tools/check-click-budget.cjs "$study" "$out/click-budget"
run budget-coverage node tools/check-budget-coverage.cjs "$out"
run file-drop node tools/check-file-drop.cjs --study "$series" --output "$out/file-drop"
run engine-pipe node tools/check-engine-pipe.cjs
run crash-reports node tools/check-crash-reporting.cjs "$out/crash-reports.json"
run engine-recovery node tools/check-engine-recovery.cjs "$series" "$out/engine-recovery"
run security-boundary node tools/check-security-boundary.cjs "$series" "$out/security-boundary"
run pictures node tools/check-pictures.cjs "$series" "$out/pictures"
run interface node tools/check-interface.cjs "$series" "$out/interface"
run pet-followup-fixture node tools/fixtures/make-pet-followup.mjs "$out/pet-followup"
run pet-voi node tools/check-pet-voi.cjs "$out/pet-followup" "$out/pet-voi"
run pet-validation-inputs node tools/fixtures/make-pet-validation-inputs.mjs "$out/pet-followup"
run pet-validation node tools/pet-validation.cjs "$out/pet-followup" "$out/pet-followup/pet-validation-spheres.json" "$out/pet-validation" --vendor "$out/pet-followup/pet-validation-expected.json"
run pet-validation-cases node tools/check-pet-validation-cases.mjs "$out/pet-followup" "$out/pet-validation-cases"
run petct-fixture node tools/fixtures/make-petct-study.mjs "$out/petct-study"
run arrangements node tools/check-arrangements.cjs "$out/petct-study" "$out/arrangements"
run pet-reading node tools/check-pet-reading.cjs "$out/petct-study" "$out/pet-reading"
run nm-fixture node tools/fixtures/make-nm-study.mjs "$out/nm-study"
run gamma-camera node tools/check-gamma-camera.cjs "$out/nm-study" "$out/gamma-camera"
run browser-gpu node tools/check-browser-gpu.mjs "$out/browser-gpu"
run gpu-startup node tools/check-gpu-startup.cjs "$series" "$out/gpu-startup.json"
run hardware-rendering node tools/check-software-rendering.cjs "$series" "$out/hardware-rendering" --expect hardware
run export node tools/capture-export.cjs "$study" "$out/export"
run export-diff node tools/diff-png.mjs tests/golden/ct-small.png "$out/export/current.png" "$out/export/diff.png"
echo 'All verification steps passed.'
