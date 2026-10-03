/* rusty-model-host — the bundled local model server for Grumpy's Rusty Platform.
 *
 * WHY THIS EXISTS. The AI coding assist has to work for a developer who has no AI at all: no Copilot, no LM
 * Studio, no Ollama, no cloud key. Shipping an inference runtime inside the VSIX would mean one build per
 * platform *and* a rebuild every time VS Code's Node ABI moves, and the weights — gigabytes — can never
 * travel in a VSIX at all. So the extension ships *this source* and builds it with the Rust toolchain the
 * user already has, exactly as it builds their firmware; llama.cpp comes from the crate, is compiled for
 * this machine, and the weights are downloaded once into the extension's storage.
 *
 * WHAT IT IS. A deliberately small HTTP server on 127.0.0.1 speaking the subset of the OpenAI API the
 * extension's client already uses (`api.rs`), backed by `llama-cpp-2` (`engine.rs`).
 *
 * ONE THREAD OWNS THE MODEL, AND THAT IS NOT AN OPTIMISATION. `LlamaContext` and `LlamaSampler` hold raw
 * pointers and are **not `Send`**, so an engine cannot live in a shared `Arc<Mutex<...>>` and be used from
 * whichever thread a request lands on. Instead one dedicated OS thread loads the model and then serves jobs
 * off a channel, in order; every HTTP request posts a job and reads its answer back over a channel. That is
 * also what makes the server single-flight by construction: one worker, one context, one generation.
 *
 * THE STARTUP ORDER IS THE CONTRACT. The listener is bound and `MODEL_HOST_READY` is printed **before** the
 * weights are loaded, and `/health` answers immediately with `{ loading: true }`. Loading a 4 GB model takes
 * tens of seconds, and the extension's status line can say "loading, 12s" instead of showing nothing — which
 * is why the two steps are not one.
 *
 * A DIRECT `cargo run` FROM THIS DIRECTORY is the fastest way to see the server on its own:
 *
 *     cargo run --release -- --model /path/to/model.gguf --port 8080 --ctx 4096
 *
 * The `--backend` value is accepted for the caller's benefit (it is echoed in `/health`), but the backend
 * that actually runs is the cargo feature the binary was built with (`cli.rs::compiled_backend`).
 */

mod api;
mod cli;
mod engine;
mod openai;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Context, Result};
use llama_cpp_2::llama_backend::LlamaBackend;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::cli::Config;
use crate::engine::{Engine, GenParams};
use crate::openai::Message;

/// Printed on stdout once the port is bound. The extension waits for this exact prefix.
pub const READY_PREFIX: &str = "MODEL_HOST_READY";

/// One piece of an answer, on its way from the model thread to an HTTP response.
pub enum Chunk {
    /// Text to append. Its arrival is what the client renders token by token.
    Delta(String),
    /// The model stopped. The counts are what turn "0 characters" into an explanation.
    Done {
        finish_reason: String,
        completion_tokens: u32,
        prompt_tokens: usize,
    },
    Error(String),
    /// The end of the answer; the SSE side renders it as `data: [DONE]`.
    End,
}

/// One unit of work for the model thread.
pub struct Job {
    pub messages: Vec<Message>,
    pub params: GenParams,
    pub tx: mpsc::Sender<Chunk>,
}

/// What the process is doing, as `/health` reports it. Written by the model thread.
pub struct Status {
    pub loaded: bool,
    pub loading: bool,
    pub model: String,
    pub error: Option<String>,
}

/// Everything a request handler needs — deliberately nothing that owns the model.
pub struct AppState {
    /// Jobs go here; the model thread is the only reader.
    pub jobs: UnboundedSender<Job>,
    pub status: StdMutex<Status>,
    /// Set while a generation runs, so a second request is refused instead of queued behind a wait it did
    /// not ask for. The model thread clears it when the job is done, however it ends.
    pub busy: Arc<AtomicBool>,
    /// What the caller asked for with `--backend` (reported, never trusted).
    pub requested_backend: String,
    /// The window the caller asked for.
    pub context_size: u32,
}

/// Clears the busy flag when the job it guards ends — including a panic, which would otherwise leave the
/// endpoint refusing every request until the window was reloaded.
struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `--help` is a question, not an error: answer it on stdout and exit successfully.
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", cli::USAGE);
        return Ok(());
    }
    let config = match cli::parse(args.into_iter()) {
        Ok(config) => config,
        Err(message) => {
            // A usage error is not a crash: say what is wrong and exit with the conventional code.
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    // The backend owns llama.cpp's global state and must outlive every model; it is initialised once here
    // and leaked, so no `Drop` can free it while the weights are still alive. It is a zero-sized proof of
    // initialisation, so sharing it with the model thread is free.
    let backend: &'static LlamaBackend = Box::leak(Box::new(
        LlamaBackend::init().context("the llama.cpp backend could not be initialised")?,
    ));

    let initial_name = config
        .model
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "local-model".to_string());
    let (jobs, job_rx) = mpsc::unbounded_channel::<Job>();
    let state = Arc::new(AppState {
        jobs,
        status: StdMutex::new(Status {
            loaded: false,
            loading: true,
            model: initial_name,
            error: None,
        }),
        busy: Arc::new(AtomicBool::new(false)),
        requested_backend: config.backend.clone(),
        context_size: config.context_size,
    });

    {
        let state = Arc::clone(&state);
        let config = config.clone();
        std::thread::Builder::new()
            .name("model".to_string())
            .spawn(move || serve_jobs(backend, &config, job_rx, &state))
            .context("the model thread could not be started")?;
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", config.port))
        .await
        .with_context(|| format!("could not bind 127.0.0.1:{}", config.port))?;

    // The extension is waiting for this line; flush it before serving so a redirected pipe sees it.
    {
        use std::io::Write;
        println!("{READY_PREFIX} {}", config.port);
        let _ = std::io::stdout().flush();
    }

    axum::serve(listener, api::router(Arc::clone(&state)))
        .await
        .context("the HTTP server stopped")?;
    Ok(())
}

/// The model thread: load once, then answer jobs in order.
///
/// Everything that touches llama.cpp happens in this function, on this thread. A failed load ends the
/// thread on purpose — the process stays up so `/health` can report *why*, and the extension shows that
/// sentence instead of a bare "the runtime stopped".
fn serve_jobs(
    backend: &'static LlamaBackend,
    config: &Config,
    mut rx: UnboundedReceiver<Job>,
    state: &Arc<AppState>,
) {
    // `catch_unwind` because llama.cpp is C++ behind a safe wrapper and its failures do not have to be
    // polite. A panic that escaped here would kill the model thread and leave `/health` saying
    // `loading: true` for ever — the extension would sit on its ten-minute timeout instead of reading a
    // sentence it can act on. The panic is turned into the same `error` any failed load produces.
    let loaded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Engine::load(backend, config)));
    let mut engine = match loaded {
        Ok(Ok(engine)) => {
            let id = engine.model_id();
            {
                let mut status = state.status.lock().unwrap();
                status.model = id;
                status.loaded = true;
                status.loading = false;
            }
            eprintln!(
                "model loaded: {} (ctx {}, backend {})",
                state.status.lock().unwrap().model,
                config.context_size,
                cli::compiled_backend()
            );
            engine
        }
        Ok(Err(error)) => {
            fail(state, format!("{error:#}"));
            return;
        }
        Err(panic) => {
            fail(state, format!("the model runtime panicked: {}", panic_text(&panic)));
            return;
        }
    };

    while let Some(job) = rx.blocking_recv() {
        let _busy = BusyGuard(Arc::clone(&state.busy));
        let Job { messages, params, tx } = job;
        // One panic must not end a server that is otherwise fine: it is reported on this request and the
        // loop keeps serving the next one. The context may be in whatever state the panic left it, which is
        // strictly better than every later request hanging on a worker that is gone.
        let produced = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let prompt = engine.render_prompt(&messages);
            let mut send = |piece: &str| tx.blocking_send(Chunk::Delta(piece.to_string())).is_ok();
            engine.generate(&prompt, &params, &mut send)
        }));
        match produced {
            Ok(Ok(stats)) => {
                let _ = tx.blocking_send(Chunk::Done {
                    finish_reason: stats.finish_reason.to_string(),
                    completion_tokens: stats.tokens,
                    prompt_tokens: stats.prompt_tokens,
                });
            }
            Ok(Err(error)) => {
                let _ = tx.blocking_send(Chunk::Error(format!("{error:#}")));
            }
            Err(panic) => {
                let _ = tx.blocking_send(Chunk::Error(format!(
                    "the model runtime panicked: {}",
                    panic_text(&panic)
                )));
            }
        }
        let _ = tx.blocking_send(Chunk::End);
    }
}

/// Records a load failure where `/health` will read it, and says it in the log too.
fn fail(state: &Arc<AppState>, message: String) {
    let mut status = state.status.lock().unwrap();
    status.loading = false;
    status.error = Some(message.clone());
    eprintln!("model load failed: {message}");
}

/// The text out of a `catch_unwind` payload, which is a `&str` or a `String` in practice.
fn panic_text(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(text) = panic.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = panic.downcast_ref::<String>() {
        text.clone()
    } else {
        "unknown panic".to_string()
    }
}
