# Native renderer decision

Reviewed 3 November 2026 against the original request attachment and the current migration checkout. Read-only review; no new benchmark or cloud run. The user asks for the best viewer with the surgeon's functions and familiar interface preserved. The pasted Claude discussion is context, not an architecture specification.

**Recommendation: keep Electron for controls; make a native Rust engine own imaging state, exact source data, decoding, measurements, GPU residency and rendering. Use wgpu over Metal/D3D12, software-managed volume bricks, and a small platform presentation bridge. Qualify that bridge on Windows and Mac before committing to its interface.** This recommendation rests on data ownership, scheduling and correctness, not migration effort or the language used to write shaders.

The existing app has a Rust decoder/export service and a TypeScript WebGL renderer. `native/Cargo.toml` has no GPU renderer dependency. It is not yet the proposed Rust GPU architecture.

## Four remaining defects against that plan

| Defect | Current evidence | Required architectural change |
| --- | --- | --- |
| **1. One texture is treated as the entire spatial volume.** | `src/imaging/sliceRenderer.ts` allocates one `texImage3D` for reconstruction; over-limit stacks lose MPR, fusion and 3D. The source-display patch now uses the larger 2D texture limit correctly. `VolumeView.tsx` still allocates separate full scalar/mask 3D textures. | Logical volume addressing through bounded bricks and a residency table. Tile source images exceeding the 2D limit too. Share scalar bricks across 2D, MPR, fusion and surgery. |
| **2. Whole-volume transfer/upload remains a blocking reconstruction transition.** | `src/api.ts` receives a complete `/volume` array; the renderer uploads it on the interface thread and calls `getError`. Existing instrumented CT1000 traces recorded 234–318 ms in the first full-volume render, including upload and synchronization. These are internal profiles of the earlier whole-volume display path, not measurements of the new 2D source path or a matched old/new benchmark. MPR still uses a full upload. | Decode and upload requested regions in bounded work units on native workers/render thread; pooled staging; asynchronous completion. No whole-volume scalar array crossing into JavaScript. |
| **3. Memory ownership remains split and volume-sized.** | Native decoded data, frontend arrays, source-frame cache, assessment worker, shared 2D renderer and Three.js 3D renderer have separate budgets/copies. The concurrent patch improves frame texture keys and visible-view awareness, but does not make these one bounded working set or share 3D scalar/mask residency. | One residency manager across all visible viewports and 3D. Pin visible bricks, bound prefetch, prioritize interaction, cancel obsolete work, adapt to memory pressure. |
| **4. Progressive paging is not yet a progressive imaging engine.** | The new `SourceFrameCache` permits source paging during full decode. Full-volume acquisition still runs, while MPR, fusion, assessment and surgery depend on complete arrays. Active geometry/measurements also remain split between TypeScript and Rust. | Stable source/frame identity and one authoritative clinical state. Exact region requests for measurements and reconstruction; complete-volume loading must not gate unrelated operations. Preserve source paging as a separate first-class path. |

The first three are implementation choices, not proof that WebGL cannot implement a good viewer. WebGL2 supports workers, partial texture updates and sync objects. A worker-based, bricked WebGL renderer could solve much of this. Conversely, porting the current single-texture design to Rust would retain its limits. [Khronos WebGL2 specification](https://registry.khronos.org/webgl/specs/2.0/)

The earlier eight-texture eviction rule could thrash more than eight distinct visible series. That is being patched during this review and is not listed above as an unresolved defect. Same-series linked panes already shared textures; claiming that every linked pane necessarily reuploaded its volume would be incorrect. Source-frame paging now avoids the original whole-volume paging gate. These improvements do not supply progressive reconstruction.

The 2048 problem is **not uniquely a browser limit**: Apple's Metal table lists 2048 for a single 3D texture dimension; D3D12 specifies the same bound. wgpu's default is also 2048. Bricking removes the logical volume's dependence on a single texture's dimensions. It does not increase the physical texture limit. [Apple Metal feature tables](https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf), [Microsoft D3D12 constants](https://learn.microsoft.com/en-us/windows/win32/direct3d12/constants), [wgpu limits](https://docs.rs/wgpu/latest/wgpu/struct.Limits.html)

## Engine and interface

- **Rust owns exact data.** Preserve source integer/floating representation, per-frame rescale/padding and frame identity. Use double precision for patient geometry and clinical calculations where required; GPU display approximations are separate. Measurements and exports never sample a coarse display level. Source-frame identity must survive provisional study ordering.
- **Use a software brick atlas/page table first.** Key bricks by source revision, channel/time, level and coordinates; include interpolation halos. Choose sizes from measured workloads, not a universal constant. Produce coarse levels in the background, while requested full-resolution source frames decode immediately. Current wgpu public features do not provide a portable sparse-residency abstraction; optional Metal/D3D12 sparse backends can follow without changing the engine contract. [wgpu features](https://docs.rs/wgpu/latest/wgpu/struct.Features.html), [Metal sparse texture memory](https://developer.apple.com/documentation/metal/managing-sparse-texture-memory)
- **Bound memory and work globally.** Separate CPU source, derived brick, mask and GPU budgets. Upload through reusable staging buffers with backpressure; never wait for GPU completion on Electron's interface thread. Native queue writes still copy into staging: Rust does not eliminate transfer cost. Windows exposes a process video-memory budget; exceeding it can cause paging/stutter. [wgpu queue](https://docs.rs/wgpu/latest/wgpu/struct.Queue.html), [DXGI memory budget](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_4/nf-dxgi1_4-idxgiadapter3-queryvideomemoryinfo)
- **Publish an immutable frame state.** Image, annotations, orientation, window/level and slice labels use the same displayed revision. A pick refers to that frame's transform. Missing data must not silently appear as zero-valued anatomy. Report coverage and display approximation explicitly. Surgery masks are separate versioned layers, with region deltas for undo; source pixels remain unchanged.

The control channel carries small typed commands, not pixels:

```text
OpenStudy(paths, requestId)
SetView(viewportId, sourceRevision, viewRevision, sourceFrameId | planeLps, display, slab, fusion)
Measure(sourceRevision, roiLps, exactSamplingMethod)
EditMask(maskRevision, operationInPatientSpace)
FrameReady(viewportId, frameId, sourceRevision, viewRevision,
           surfaceLease, dimensions, format, colorSpace, coverage, displayLevel)
Pick(frameId, viewportPixel)
ReleaseFrame(surfaceLease)
```

Separate GPU-completed, delivered-to-compositor and screen-observed events. They measure different things. Human input, tests and future agents should use the same validated command path; choosing Rust alone is not formal verification.

## Electron presentation: promising, but qualify it first

Electron's official **experimental** `sharedTexture` API can import a native texture and deliver a `VideoFrame` to a renderer. It documents Windows NT handles and macOS IOSurfaces. This can keep ordinary Electron controls and avoid CPU bitmap readback. It does not establish zero internal GPU copies, calibrated grayscale, or our Windows producer's compatibility. [Electron sharedTexture](https://www.electronjs.org/docs/latest/api/shared-texture), [texture handles](https://www.electronjs.org/docs/latest/api/structures/shared-texture-handle)

Real integration risks are:

1. **Exportable allocations and process ownership.** A normal wgpu texture is not automatically an Electron-compatible shareable allocation. A small Metal/D3D12 interop layer must create/wrap the proper resource. Separate processes need actual handle/right transfer; sending a numeric pointer through JSON is invalid. [wgpu native device access](https://docs.rs/wgpu/latest/wgpu/struct.Device.html), [D3D12 shared handles](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12device-createsharedhandle)
2. **Producer/consumer synchronization.** Publish only after native GPU completion unless an explicitly supported fence path is proven. Reuse a surface only after both producer completion and all Electron consumers release it. Use a bounded two/three-surface queue and discard stale unpublished frames. Electron import's documented interface does not expose an arbitrary external producer-fence field. [import contract](https://www.electronjs.org/docs/latest/api/structures/shared-texture-import-texture-info), [imported texture lifetime](https://www.electronjs.org/docs/latest/api/structures/shared-texture-imported)
3. **Platform coverage and display behavior.** Upstream's current shared-texture integration suite skips platforms other than macOS ARM64. Windows is documented, but must be qualified on our actual adapters. Test format, alpha, color space, DPI, resize, multi-monitor moves, minimize/restore and device loss. Do not infer 10/12-bit diagnostic display support from a half-float input format. [Electron upstream integration tests](https://github.com/electron/electron/blob/main/spec/api-shared-texture.spec.ts)

If the import path fails qualification, retain the Rust engine and replace only the presenter with a native child HWND/NSView surface. That requires explicit ownership of viewport clipping, input, DPI and clinical overlays; `getNativeWindowHandle` alone is not a finished integration. A second option is native window composition with Electron's offscreen shared UI texture, which changes window/input/accessibility ownership. Neither fallback should return whole voxel arrays to JavaScript. [D3D12 HWND swap chain](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgifactory2-createswapchainforhwnd), [Metal custom view](https://developer.apple.com/documentation/metal/creating-a-custom-metal-view), [Electron offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)

## Delivery gates

1. **Presentation prototype:** native checkerboard and numbered frames through the real Mac and Windows packaged app, while controls remain responsive. Stress resizing and stale-frame disposal. Demonstrate bounded handles/memory, correct colors and no premature surface reuse; instrument actual GPU completion and screen presentation separately. Fail this gate before building the volume renderer around an assumed bridge.
2. **One source view:** exact requested frame/tile appears without full-series decode, including stacks over 2048 and images wider than one 3D texture. Rapid forward/reverse requests, reimport and cancellation never publish the wrong revision. Source metadata, pixels and overlays agree.
3. **Shared bricked reconstruction:** MPR, oblique slabs, PET fusion and 3D use the same residency system. Exercise volumes larger than RAM/VRAM, anisotropic/sheared geometry, brick boundaries, 25 visible series, and sustained navigation. Missing-data behavior stays explicit; no 2048-based feature disabling.
4. **Clinical and surgery parity:** route preserved ROI, assessment, interpolated VOI, burr, STL and exports through authoritative exact-data operations. Compare against independent CPU geometry/pixel oracles and the original workflows. Capture the same scenes and use the same screen-observed benchmark on the same machine before claiming improvement.

The current source-paging patch, chunked assessment worker and cache fixes are worthwhile. They do not deliver out-of-core MPR/3D, unify clinical ownership, or remove the whole-volume upload transition. Removing a synchronization call can move the wait; it is not evidence that the work disappeared. The native design is complete only when these delivery gates pass.
