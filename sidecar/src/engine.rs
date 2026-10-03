/* The model, the context, and one generation at a time.
 *
 * WHY THE MODEL IS LEAKED. `llama-cpp-2`'s `LlamaContext<'a>` borrows the `LlamaModel` it was created from,
 * which is the one thing Rust's ownership model cannot express as a plain struct field: an `Engine` holding
 * both would be self-referential. A sidecar serves one model for the lifetime of the process, so the model
 * is leaked to `&'static` and the context borrows *that*. The alternative — a self-referential crate or an
 * `unsafe` pin — buys nothing here and costs a dependency or a soundness argument.
 *
 * WHY SINGLE-FLIGHT. There is one model and one user. Two concurrent generations against one context would
 * interleave their KV cache and produce two wrong answers; the caller takes the mutex with `try_lock` and
 * answers "busy" when it is held, which is honest and matches what the extension expects.
 *
 * WHY THE CHAT TEMPLATE COMES FROM THE MODEL. `llama.cpp` applies the template the GGUF itself carries, so
 * a Qwen, a Llama and a Gemma each get their own control tokens without this program knowing any of them.
 * The fallback below exists for a model with no template at all — it is worse, and it is the honest thing to
 * send rather than refusing to answer.
 */

use std::num::NonZeroU32;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;

use crate::cli::{effective_threads, Config};
use crate::openai::Message;

/// The loaded model and its context. One of these exists per process, inside a mutex.
pub struct Engine {
    model: &'static LlamaModel,
    ctx: LlamaContext<'static>,
}

/// What one request asked for. `max_tokens` is an upper bound; the context window caps it again.
pub struct GenParams {
    pub temperature: f32,
    pub max_tokens: u32,
}

/// What one request produced.
pub struct GenStats {
    pub prompt_tokens: usize,
    pub tokens: u32,
    /// `stop` (the model finished), `length` (the budget ran out), `cancelled` (the client went away).
    pub finish_reason: &'static str,
}

impl Engine {
    /// Loads the weights and creates a context sized for the configured window.
    ///
    /// `backend` is `&'static` because the whole llama.cpp backend must outlive every model in the process:
    /// it is initialised once in `main` and leaked there, so a `drop` can never free it while the weights
    /// are still alive.
    pub fn load(backend: &'static LlamaBackend, cfg: &Config) -> Result<Self> {
        // Checked here rather than left to llama.cpp: the crate's own guard is a `debug_assert!`, so a
        // missing file panics in a debug build and only fails cleanly in release. A path that is wrong is a
        // message the user can act on, never a dead thread.
        if !cfg.model.is_file() {
            return Err(anyhow!("the model file does not exist: {}", cfg.model.display()));
        }
        let params = LlamaModelParams::default().with_n_gpu_layers(cfg.gpu_layers);
        let model = LlamaModel::load_from_file(backend, &cfg.model, &params)
            .with_context(|| format!("could not load the model at {}", cfg.model.display()))?;
        let model: &'static LlamaModel = Box::leak(Box::new(model));

        let threads = effective_threads(cfg.threads);
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(cfg.context_size))
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let ctx = model
            .new_context(backend, ctx_params)
            .context("the model loaded but its context could not be created")?;
        Ok(Self { model, ctx })
    }

    /// The model's own id, for `/v1/models` and `/health`.
    pub fn model_id(&self) -> String {
        self.model
            .meta_val_str("general.name")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                self.model
                    .meta_val_str("general.basename")
                    .unwrap_or_else(|_| "local-model".to_string())
            })
    }

    /// Renders the conversation with the model's own template.
    pub fn render_prompt(&self, messages: &[Message]) -> String {
        let chat: Vec<LlamaChatMessage> = messages
            .iter()
            .filter_map(|m| LlamaChatMessage::new(m.role.clone(), m.content.clone()).ok())
            .collect();
        if let Ok(template) = self.model.chat_template(None) {
            if let Ok(rendered) = self.model.apply_chat_template(&template, &chat, true) {
                return rendered;
            }
        }
        // No template (or it refused the messages): a plain transcript. Worse, and still better than
        // refusing to answer at all.
        let mut out = String::new();
        for m in messages {
            out.push_str("### ");
            out.push_str(&m.role);
            out.push_str(":\n");
            out.push_str(&m.content);
            out.push_str("\n\n");
        }
        out.push_str("### assistant:\n");
        out
    }

    /// Runs one generation, handing every piece of text to `on_token` as it is produced.
    ///
    /// `on_token` returns `false` to stop early — that is how a closed HTTP connection cancels a generation
    /// that would otherwise keep a CPU busy for another minute.
    pub fn generate<F: FnMut(&str) -> bool>(
        &mut self,
        prompt: &str,
        params: &GenParams,
        mut on_token: F,
    ) -> Result<GenStats> {
        self.ctx.clear_kv_cache();
        let tokens = self.model.vocab().tokenize(prompt.as_bytes(), true, true);
        if tokens.is_empty() {
            return Err(anyhow!("the prompt produced no tokens"));
        }
        let n_ctx = self.ctx.n_ctx() as usize;
        if tokens.len() >= n_ctx {
            return Err(anyhow!(
                "the prompt is {} tokens but the context window is {} — raise the context size or ask a \
                 shorter question",
                tokens.len(),
                n_ctx
            ));
        }
        let max_new = (n_ctx - tokens.len()).min(params.max_tokens.max(1) as usize) as u32;

        let n_batch = (self.ctx.n_batch() as usize).max(1);
        let mut batch = LlamaBatch::new(n_batch, 1);
        let mut pos: i32 = 0;
        let mut i = 0usize;
        while i < tokens.len() {
            batch.clear();
            let end = (i + n_batch).min(tokens.len());
            for (offset, token) in tokens[i..end].iter().enumerate() {
                // Logits are only needed for the token the sampler will read: asking for them all is how a
                // long prompt becomes slow and memory-hungry for no gain.
                let is_last = i + offset + 1 == tokens.len();
                batch.add(*token, pos, &[0], is_last)?;
                pos += 1;
            }
            self.ctx.decode(&mut batch)?;
            i = end;
        }

        let mut samplers: Vec<LlamaSampler> = Vec::new();
        if params.temperature > 0.0 {
            samplers.push(LlamaSampler::temp(params.temperature));
        }
        samplers.push(LlamaSampler::dist(seed_now()));
        let mut sampler = LlamaSampler::chain_simple(samplers);

        let mut generated = 0u32;
        let mut finish_reason = "length";
        while generated < max_new {
            let token = sampler.sample(&self.ctx, -1);
            sampler.accept(token);
            if self.model.vocab().is_eog(token) {
                finish_reason = "stop";
                break;
            }
            generated += 1;
            let piece = self.model.vocab().token_to_piece(token, false, None);
            if !piece.is_empty() && !on_token(&String::from_utf8_lossy(&piece)) {
                finish_reason = "cancelled";
                break;
            }
            batch.clear();
            batch.add(token, pos, &[0], true)?;
            pos += 1;
            self.ctx.decode(&mut batch)?;
        }

        Ok(GenStats {
            prompt_tokens: tokens.len(),
            tokens: generated,
            finish_reason,
        })
    }
}

/// A per-request seed. Sampling is the one place where two identical requests may differ, and a clock is
/// the cheapest source that is not a constant.
fn seed_now() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
}
