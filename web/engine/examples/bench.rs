//! cargo run --release --example bench -- <folder or zip>...
//! Prints one JSON line per path: the native build of the browser engine, timed from disk.

fn main() {
    for path in std::env::args().skip(1) {
        match veacom_web_engine::bench::run(&path) {
            Ok(line) => println!("{line}"),
            Err(error) => eprintln!("{path}: {error:#}"),
        }
    }
}
