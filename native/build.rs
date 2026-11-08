fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/render/surface.m")
            .flag("-fobjc-arc")
            .compile("metal_surface");
        for framework in ["Foundation", "Metal", "IOSurface"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rerun-if-changed=src/render/surface.m");
    }
}
