/* The command line, parsed by hand.
 *
 * WHY NO ARGUMENT CRATE. Four options and one flag do not justify a dependency in a program that is built
 * on the user's machine: every crate added here is code the user downloads and compiles before their AI
 * assist works, and the whole point of this sidecar is to be small. It is also a *contract*: the extension's
 * `modelSpecs.ts` writes this exact argv, so the parser and the writer are two halves of one thing and are
 * easy to keep in step when the parser is this small.
 *
 * THE CONTRACT (mirrored in `src/ai/modelSpecs.ts` `sidecarArgs`):
 *
 *     --model <path.gguf>   required
 *     --port <n>            required
 *     --ctx <n>             default 4096
 *     --gpu-layers <n>      default 0 (CPU)
 *     --backend <name>      default cpu; what the *caller asked for*, which is reported back in /health only
 *                           when the binary was actually built with that backend
 *     --threads <n>         optional; 0/absent means "choose"
 */

use std::path::PathBuf;

/// Everything the process needs to know, after parsing.
#[derive(Clone, Debug)]
pub struct Config {
    pub model: PathBuf,
    pub port: u16,
    pub context_size: u32,
    pub gpu_layers: u32,
    pub backend: String,
    pub threads: Option<i32>,
}

/// The usage line, for a bad invocation (the extension never sends one, a human by hand might).
pub const USAGE: &str =
    "usage: rusty-model-host --model <file.gguf> --port <n> [--ctx <n>] [--gpu-layers <n>] \
     [--backend cpu|vulkan|cuda|metal] [--threads <n>]";

/// Parses `argv` (without the program name). Unknown arguments are an error, not ignored: a typo in a flag
/// must not silently produce a server on the wrong port.
pub fn parse(args: impl Iterator<Item = String>) -> Result<Config, String> {
    let mut model: Option<PathBuf> = None;
    let mut port: Option<u16> = None;
    let mut context_size: u32 = 4096;
    let mut gpu_layers: u32 = 0;
    let mut backend = String::from("cpu");
    let mut threads: Option<i32> = None;

    let argv: Vec<String> = args.collect();
    let mut i = 0;
    while i < argv.len() {
        let flag = argv[i].as_str();
        let value = |i: usize| -> Result<&String, String> {
            argv.get(i + 1).ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag {
            "--model" => {
                model = Some(PathBuf::from(value(i)?));
                i += 2;
            }
            "--port" => {
                let raw = value(i)?;
                port = Some(raw.parse::<u16>().map_err(|_| format!("--port: `{raw}` is not a port"))?);
                i += 2;
            }
            "--ctx" => {
                let raw = value(i)?;
                context_size = raw.parse::<u32>().map_err(|_| format!("--ctx: `{raw}` is not a number"))?;
                i += 2;
            }
            "--gpu-layers" => {
                let raw = value(i)?;
                gpu_layers = raw
                    .parse::<u32>()
                    .map_err(|_| format!("--gpu-layers: `{raw}` is not a number"))?;
                i += 2;
            }
            "--threads" => {
                let raw = value(i)?;
                let n = raw
                    .parse::<i32>()
                    .map_err(|_| format!("--threads: `{raw}` is not a number"))?;
                threads = if n > 0 { Some(n) } else { None };
                i += 2;
            }
            "--backend" => {
                backend = value(i)?.to_lowercase();
                i += 2;
            }
            "--help" | "-h" => return Err(USAGE.to_string()),
            other => return Err(format!("unknown argument `{other}`\n{USAGE}")),
        }
    }

    let model = model.ok_or_else(|| format!("--model is required\n{USAGE}"))?;
    let port = port.ok_or_else(|| format!("--port is required\n{USAGE}"))?;
    if context_size < 512 {
        return Err("--ctx must be at least 512".to_string());
    }
    Ok(Config {
        model,
        port,
        context_size,
        gpu_layers,
        backend,
        threads,
    })
}

/// The backend the *binary* was compiled for.
///
/// A cargo feature is a compile-time choice, so this is not the same question as `--backend` — it is the
/// honest answer to "what will actually run", which is what `/health` has to report. The extension shows
/// this rather than what the user asked for, so "Vulkan" can never appear for a CPU build.
pub fn compiled_backend() -> &'static str {
    if cfg!(feature = "vulkan") {
        "vulkan"
    } else if cfg!(feature = "cuda") {
        "cuda"
    } else if cfg!(feature = "metal") {
        "metal"
    } else {
        "cpu"
    }
}

/// Threads to run with: the caller's number, else one less than the cores capped at 8 — the same rule the
/// extension applies (`modelSpecs.defaultThreads`), so the log line and the sidecar cannot disagree.
pub fn effective_threads(requested: Option<i32>) -> i32 {
    if let Some(n) = requested {
        if n > 0 {
            return n;
        }
    }
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as i32;
    (cores - 1).clamp(1, 8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> impl Iterator<Item = String> {
        // Collected so the iterator owns its strings: a borrow of the slice cannot be returned from a
        // helper whose lifetime is not named, and the tests do not care about the allocation.
        items.iter().map(|s| (*s).to_string()).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn parses_the_contract_the_extension_writes() {
        let cfg = parse(argv(&[
            "--model",
            "/models/x.gguf",
            "--port",
            "8123",
            "--threads",
            "6",
            "--ctx",
            "8192",
            "--gpu-layers",
            "12",
            "--backend",
            "vulkan",
        ]))
        .expect("should parse");
        assert_eq!(cfg.port, 8123);
        assert_eq!(cfg.context_size, 8192);
        assert_eq!(cfg.gpu_layers, 12);
        assert_eq!(cfg.backend, "vulkan");
        assert_eq!(cfg.threads, Some(6));
    }

    #[test]
    fn defaults_are_the_cpu_ones() {
        let cfg = parse(argv(&["--model", "m.gguf", "--port", "1"])).expect("should parse");
        assert_eq!(cfg.context_size, 4096);
        assert_eq!(cfg.gpu_layers, 0);
        assert_eq!(cfg.backend, "cpu");
        assert_eq!(cfg.threads, None);
    }

    #[test]
    fn unknown_arguments_are_refused() {
        assert!(parse(argv(&["--model", "m.gguf", "--port", "1", "--nope"])).is_err());
        assert!(parse(argv(&["--port", "1"])).is_err());
        assert!(parse(argv(&["--model", "m.gguf"])).is_err());
    }

    #[test]
    fn threads_fall_back_to_the_machine() {
        let n = effective_threads(None);
        assert!((1..=8).contains(&n));
        assert_eq!(effective_threads(Some(3)), 3);
    }
}
