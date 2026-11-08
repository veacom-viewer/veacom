#!/bin/bash

# Open the verified GitHub release disk image in Finder.
install_veacom() (
  set -euo pipefail
  umask 077
  if [[ $(uname -s) != Darwin ]] || [[ $(uname -m) != arm64 && $(sysctl -n hw.optional.arm64 2>/dev/null || true) != 1 ]]; then
    echo "VEAcom requires an Apple Silicon Mac. Windows x64 has a separate installer." >&2
    exit 1
  fi

  download() {
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 2 "$@"
  }
  tag=$(download 'https://api.github.com/repos/veacom-viewer/veacom/releases?per_page=1' | plutil -extract 0.tag_name raw -o - -)
  if [[ ! $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$ ]]; then
    echo "Could not identify a published VEAcom release." >&2
    exit 1
  fi
  base="https://github.com/veacom-viewer/veacom/releases/download/$tag"
  asset="VEAcom-Electron-${tag#v}-mac-arm64.dmg"
  mkdir -p "$HOME/Downloads"
  directory=$(mktemp -d "$HOME/Downloads/VEAcom.XXXXXXXX")
  trap 'rm -f "$directory/SHA256SUMS.txt" "$directory/$asset"; rmdir "$directory" 2>/dev/null || true' EXIT
  download "$base/SHA256SUMS.txt" -o "$directory/SHA256SUMS.txt"
  expected=$(awk -v asset="$asset" '$2 == asset || $2 == ("*" asset) { print $1 }' "$directory/SHA256SUMS.txt")
  if [[ ! $expected =~ ^[[:xdigit:]]{64}$ ]]; then
    echo "The release has no unique SHA-256 checksum for $asset." >&2
    exit 1
  fi
  download "$base/$asset" -o "$directory/$asset"
  (cd "$directory" && printf '%s  %s\n' "$expected" "$asset" | shasum -a 256 -c -)
  xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");VEAcom;" "$directory/$asset"
  rm "$directory/SHA256SUMS.txt"
  trap - EXIT
  printf 'Verified %s\nDrag VEAcom Electron to Applications in the window that opens.\n' "$directory/$asset"
  open "$directory/$asset"
)

install_veacom
