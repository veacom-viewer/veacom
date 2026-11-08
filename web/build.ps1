# Builds the engine to WebAssembly twice and writes the page's modules:
#   web/engine/pkg          one thread, with the repository's stable Rust (1.99.1);
#   web/engine/pkg-threads  decoding on several threads, with a nightly Rust pinned below, whose standard library is
#                           rebuilt with atomics (-Z build-std). The page uses it when it is cross-origin isolated.
#   . D:\veacom-dev\veacom-viewer-env.ps1
#   web\build.ps1
# Needs: the wasm32-unknown-unknown target for both toolchains, rust-src for the nightly one, and wasm-bindgen-cli
# 0.2.130 (cargo install wasm-bindgen-cli --version 0.2.130 --locked).
# Exit codes are checked below; cargo's progress on stderr is not an error.
$ErrorActionPreference = 'Continue'
$web = $PSScriptRoot
$stable = '1.99.1-x86_64-pc-windows-msvc'
$nightly = 'nightly-2026-11-01-x86_64-pc-windows-msvc'
$targets = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $web 'engine\target' }

# The C functions openjp2 calls are linked with --allow-undefined; any left unresolved would become imports.
$check = "const m=new WebAssembly.Module(require('fs').readFileSync(process.argv[1]));const bad=WebAssembly.Module.imports(m).filter(i=>!i.module.startsWith('./'));if(bad.length){console.error('Unresolved:',bad.map(i=>i.module+'.'+i.name).join(' '));process.exit(1)}"

function Build-Engine([string]$toolchain, [string]$targetDir, [string]$out, [string[]]$cargoArgs, [string]$rustflags) {
    $env:RUSTUP_TOOLCHAIN = $toolchain
    $env:CARGO_TARGET_DIR = $targetDir
    $saved = $env:RUSTFLAGS
    if ($rustflags) { $env:RUSTFLAGS = $rustflags }
    Push-Location (Join-Path $web 'engine')
    try {
        & cargo build --release --target wasm32-unknown-unknown @cargoArgs
        if ($LASTEXITCODE) { throw "cargo build failed ($out)" }
    } finally { Pop-Location; $env:RUSTFLAGS = $saved }
    $wasm = Join-Path $targetDir 'wasm32-unknown-unknown\release\veacom_web_engine.wasm'
    $dir = Join-Path $web "engine\$out"
    wasm-bindgen --target web --out-dir $dir $wasm
    if ($LASTEXITCODE) { throw "wasm-bindgen failed ($out)" }
    node -e $check (Join-Path $dir 'veacom_web_engine_bg.wasm')
    if ($LASTEXITCODE) { throw "the module has unresolved imports ($out)" }
}

Build-Engine $stable $targets 'pkg' @() $null

# Shared memory for the threads, up to the 4 GB a 32-bit module can address. The memory is shared and given to the
# module from outside (so every helper Worker can be handed the same one), and each thread sets up its own
# thread-local storage with the __wasm_init_tls/__tls_* exports; this nightly's linker step does not add these by
# itself. RUSTFLAGS replaces the rustflags of engine/.cargo/config.toml, so its settings (the openjp2 link setting,
# SIMD) are repeated here.
$threadFlags = @(
    '-C target-feature=+atomics,+bulk-memory,+simd128'
    '-C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=4294967296'
    '-C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base'
    '-C link-arg=--allow-undefined'
) -join ' '
Build-Engine $nightly "$targets-threads" 'pkg-threads' @('--features', 'threads', '-Z', 'build-std=panic_abort,std') $threadFlags

$env:RUSTUP_TOOLCHAIN = $stable
Write-Host 'web/engine/pkg and web/engine/pkg-threads are ready.'
