#[test]
fn native_render_shaders_validate_without_a_gpu() {
    for source in [
        include_str!("render/pattern.wgsl"),
        include_str!("render/composite.wgsl"),
        concat!(
            include_str!("render/voxels.wgsl"),
            include_str!("render/volume.wgsl")
        ),
        concat!(
            include_str!("render/voxels.wgsl"),
            include_str!("render/image.wgsl")
        ),
    ] {
        let module = naga::front::wgsl::parse_str(source).unwrap();
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .unwrap();
    }
}
