/* The three endpoints.
 *
 * THE SHAPE (what `src/ai/assistant.ts` talks to):
 *
 *   GET  /health             -> { ok, loaded, loading, model, error, backend, device, context }
 *   GET  /v1/models          -> { object: "list", data: [ { id, object: "model" } ] }
 *   POST /v1/chat/completions -> SSE `data: {…}` deltas + a closing `data: [DONE]`, or one JSON body
 *
 * STREAMING IS WHY THE RESPONSE IS BUILT THE WAY IT IS. On a CPU a 3B model needs 5-15 seconds for a short
 * answer, and the developer should watch characters arrive instead of a frozen progress bar. The handler
 * never touches the model: it posts a job to the model thread and maps the chunks that come back onto SSE
 * events, so the async runtime is never blocked by a model and a closed connection stops the generation
 * (the model thread's `blocking_send` fails, `on_token` returns false, and the loop ends).
 *
 * ONE GENERATION AT A TIME, ENFORCED WITH AN ATOMIC. The check-and-set happens in the handler, so a second
 * request gets a clean `429` before any response body is committed; the model thread clears the flag when
 * the job ends, however it ends.
 */

use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde_json::json;
use tokio_stream::wrappers::ReceiverStream;

use crate::engine::GenParams;
use crate::openai::{self, ChatRequest};
use crate::{cli, AppState, Chunk, Job};

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(completions))
        .with_state(state)
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": { "message": message.into(), "type": "local_model_host" } }))).into_response()
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let status = state.status.lock().unwrap();
    Json(json!({
        "ok": status.loaded,
        "loaded": status.loaded,
        "loading": status.loading,
        "model": status.model,
        "error": status.error,
        // What the binary was compiled with, never what was asked for: llama.cpp silently keeps a layer
        // budget on the CPU when the GPU backend is not there, and the status line must not claim it.
        "backend": cli::compiled_backend(),
        "device": null,
        "context": state.context_size,
        "requested_backend": state.requested_backend
    }))
}

async fn models(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let status = state.status.lock().unwrap();
    Json(json!({
        "object": "list",
        "data": [{ "id": status.model, "object": "model", "owned_by": "rusty-platform" }]
    }))
}

async fn completions(State(state): State<Arc<AppState>>, Json(request): Json<ChatRequest>) -> Response {
    if request.messages.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "`messages` must not be empty");
    }
    {
        let status = state.status.lock().unwrap();
        if let Some(error) = &status.error {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error.clone());
        }
        if !status.loaded {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, "the model is still loading");
        }
    }
    if state.busy.swap(true, Ordering::SeqCst) {
        return error_response(StatusCode::TOO_MANY_REQUESTS, "a generation is already running");
    }

    let messages = request.messages;
    let params = GenParams {
        temperature: request.temperature.unwrap_or(0.2).clamp(0.0, 2.0),
        max_tokens: request.max_tokens.unwrap_or(2048).clamp(1, 32_768),
    };
    let model_id = state.status.lock().unwrap().model.clone();

    if request.stream.unwrap_or(false) {
        let (tx, rx) = tokio::sync::mpsc::channel::<Chunk>(64);
        if state.jobs.send(Job { messages, params, tx }).is_err() {
            state.busy.store(false, Ordering::SeqCst);
            return error_response(StatusCode::SERVICE_UNAVAILABLE, "the model thread is not running");
        }
        let stream = ReceiverStream::new(rx).map(move |chunk| {
            let data = match chunk {
                Chunk::Delta(text) => openai::chunk_json(&model_id, &text).to_string(),
                Chunk::Done { finish_reason, completion_tokens, .. } => {
                    openai::final_chunk_json(&model_id, &finish_reason, completion_tokens).to_string()
                }
                Chunk::Usage { prompt_tokens } => {
                    openai::prompt_usage_json(&model_id, prompt_tokens).to_string()
                }
                Chunk::Error(message) => json!({ "error": { "message": message } }).to_string(),
                Chunk::End => "[DONE]".to_string(),
            };
            Ok::<Event, Infallible>(Event::default().data(data))
        });
        return Sse::new(stream).keep_alive(KeepAlive::default()).into_response();
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Chunk>(64);
    if state.jobs.send(Job { messages, params, tx }).is_err() {
        state.busy.store(false, Ordering::SeqCst);
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "the model thread is not running");
    }
    let mut text = String::new();
    let mut finish_reason = String::from("stop");
    let mut completion_tokens = 0u32;
    let mut prompt_tokens = 0usize;
    while let Some(chunk) = rx.recv().await {
        match chunk {
            Chunk::Delta(piece) => text.push_str(&piece),
            Chunk::Done { finish_reason: reason, completion_tokens: tokens, prompt_tokens: prompt } => {
                finish_reason = reason;
                completion_tokens = tokens;
                prompt_tokens = prompt;
            }
            // The prompt count already reached the client in its own chunk; the final body carries it too.
            Chunk::Usage { .. } => {}
            Chunk::Error(message) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, message)
            }
            Chunk::End => break,
        }
    }
    Json(openai::full_json(
        &model_id,
        &text,
        &finish_reason,
        completion_tokens,
        prompt_tokens,
    ))
    .into_response()
}
