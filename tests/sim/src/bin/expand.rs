//! Prints the Rust `embedded-gui-codegen` generates for a KDL file, for debugging the emitter.
//!
//!     cargo run --bin expand -- screens/panel.kdl
//!
//! The designer's own emitter is tested in the t1 layer, but "is the markup we wrote being understood the
//! way we think?" is a question about the *crate's* parser and code generator, and the only honest answer is
//! the code they produce. This makes that visible without guessing or reaching for an unstable rustc flag.

fn main() {
    let path = match std::env::args().nth(1) {
        Some(path) => path,
        None => {
            eprintln!("usage: expand <file.kdl>");
            std::process::exit(2);
        }
    };
    let kdl = match std::fs::read_to_string(&path) {
        Ok(kdl) => kdl,
        Err(err) => {
            eprintln!("could not read {path}: {err}");
            std::process::exit(2);
        }
    };
    match embedded_gui_codegen::compile_kdl_to_rust(&kdl) {
        Ok(rust) => print!("{rust}"),
        Err(err) => {
            eprintln!("codegen refused the markup: {err}");
            std::process::exit(1);
        }
    }
}
