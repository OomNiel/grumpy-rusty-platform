# AI coding assist — How to Use

Rusty Platform can carry its own coding assistant so a generated project can be written with help — with no
Copilot, no cloud key and no account. It is **off by default**: nothing is downloaded or started until you
switch it on.

Two things are worth knowing before the steps:

- **It talks to an OpenAI-compatible endpoint.** The intended target is a server on your own machine
  (LM Studio, Ollama, `llama-server`, or the runtime this extension builds itself). There is no API-key
  setting, so a remote service that needs one will not work.
- **It edits Rust, one function at a time, and never behind your back.** Every change is offered as a diff
  of the whole file; applying it is a normal edit that `Ctrl+Z` undoes.

---

## 1. Turn it on

1. Open the **AI Assist** view in the Rusty Platform sidebar, or run **Rusty AI: Open the Assistant Panel**.
2. In **Model & settings**, set **Backend** to one of:
   - **A server I run** — you already have an OpenAI-compatible server.
   - **The extension's own runtime** — the extension builds and runs its own local runtime.

Save. With **A server I run**, also fill in the **Endpoint** (for example `http://127.0.0.1:1234/v1`).

### Turning it off, and the server that comes back at login

Turning the switch **off** unloads the models and stops the `llama-server` serving your endpoint. A server this
window did not start is stopped only after a dialog says what it is and what stopping it costs.

If that server is a **systemd user unit** that is enabled, the dialog has a third button: **Disable it so it
doesn't come back**. It stops the server *and* takes the unit out of your login target
(`systemctl --user disable llama-server`), so it no longer starts by itself when you log in — which matters,
because an idle `llama-server` is not free: with `-c 16384` the KV cache alone is pre-allocated at roughly
1.6 GB whether or not anything is being asked of it. The switch still starts the unit on demand when you turn the
assistant on.

Nothing is guessed: the button is offered only for a *user* unit that `systemctl` reports as enabled. A system
unit cannot be disabled without root, and the dialog says so instead.

## 2. Get a model

Three ways, and none of them need you to have installed anything first:

* **Your own llama-server** (the fastest of the three, and the one a developer usually wants). If llama.cpp is
  not on the machine, the extension **offers to download its prebuilt server** for your platform, verifies the
  checksum and installs it into its own storage; if the known **27B** (Qwen3.8-27B Q4_K_M) is not on disk it
  offers to fetch that too. Once both are known, *Rusty AI: Start My llama-server…* starts it and loads the
  weights with nothing to answer.
* **Any model from Hugging Face.** *Rusty AI: Add a Model from Hugging Face…* takes `owner/repo` or a Hub link,
  lists the `.gguf` files with their sizes, quantisation and whether they fit **this** machine, and adds the one
  you pick. Sizes and thread/context/offload defaults are worked out from the hardware in front of you, and a
  model that may not fit is a warning, not a refusal. *Rusty AI: Remove a Model I Added…* takes it off the list.
* **This extension's own runtime**, or LM Studio if you use it — both still there, both unchanged.

- **A server you already run:** start LM Studio / Ollama / `llama-server` yourself. If it serves more than
  one model, put the model id in **Model id** — some servers (Ollama) refuse an unnamed request.
- **The extension's own runtime:** run **Rusty AI: Choose a Local Model…**. It downloads the weights
  (~4.4 GB, verified against the published SHA-256) into the extension's storage and builds the sidecar the
  first time — that first build compiles llama.cpp and needs `cargo`, `cmake`, a C++ compiler and
  `libclang`. Pick **CPU** unless you installed a GPU SDK; the GPU builds need Vulkan SDK / CUDA toolkit /
  Xcode at build time.

Not sure it worked? Run **Rusty AI: Status and Hardware Check**. It prints what is configured, what the
server offers, and what the model would run on. The same dialog explains it if this machine is too small for
local inference — and offers *Use it anyway*, which sets `rustyPlatform.assistant.ignoreHostCheck`.

## 3. Ask for a change

### In the function you are looking at

1. Put the caret **inside the function** you want changed (or where a new function should go).
2. Run **Rusty AI: Implement in Function…**. A block appears at the caret:

   ```rust
   // ✎ AI: begin — write what you want below, as many lines as you like
   |
   // ✎ AI: end
   ```

3. Type what you want as ordinary comments — as many lines as you like, in your own words.
4. Press **`Ctrl+Alt+Enter`** (**`Cmd+Alt+Enter`** on macOS), or click **Send to the AI assist** on the code
   lens above the block. To abandon it, press **`Ctrl+Alt+Escape`**, or click **Discard**.

The block is removed either way, so the file is byte-identical to how it was before.

### In the AI Assist view

**On a second monitor.** The same conversation can be an **editor tab**: *Rusty AI: Open the Assistant in an
Editor Tab* (or the **In Editor Tab…** button in the view's footer). Drag that tab out of the VS Code window and
it becomes its own OS window you can put wherever you like; it returns there after a reload. Both surfaces show
one conversation — asking a question in either streams into both.

Type a question or a request in the box at the bottom and press **Enter** (**Shift+Enter** starts a new line;
**Ctrl+Enter** also sends) or click **Ask**. The assistant answers with:

- **the board and crates** — the exact profile the project was generated for and the `Cargo.toml` dependencies;
- **the file you are looking at** — or, when you have a **selection**, that selection: its lines, numbered, with a
  marked window either side and the file's own line numbers kept, so "why does line 121 not compile?" is answered
  about line 121 rather than about the top of a clipped file;
- **the Problems pane** — errors first, then warnings, deduplicated across rust-analyzer and rustc, each with its
  file:line:column and the headline of the message, and the cut stated when there are more than fit;
- **the Debug Console** of the last `probe-rs` session — the program's own lines in order, `[stderr]` marked,
  `[stopped]` and `[exited]` where they happened, and the tail rather than the boot banner. It is read through
  the debug adapter, so it exists only for sessions in this window; it starts empty and is cleared when a new
  session starts.

**Console only** (a checkbox above the box) sends *just* the Debug Console and nothing else — the question for a
defmt stream that would otherwise be drowned out by everything beside it.

**Abort** stops the answer that is being written. It is enabled only while something is running; the partial
answer is not kept, because half a function is what your next question would be answered against.

**A C++ project is answered in C++.** The assistant reads the project's language from its marker (`sketch.yaml`
makes it a sketch) and four things change with it: the standing instruction becomes *a precise C++ coding
assistant for Arduino sketches built with `arduino-cli`, drawing with LVGL 9*, the answer-shape rules are
phrased in C++ instead of in `fn`/`impl`, the project facts say which files are generated (`src/ui.cpp` and
`src/ui.h` are the Designer's, `src/panel.cpp` holds the pins and the rotation, `src/ui_handlers.cpp` is yours)
instead of listing Cargo dependencies, and only blocks fenced `cpp`, `c`, `h`, `hpp` or `ino` — or unfenced ones
— are offered under an answer for applying. A block that says `rust` in a sketch is left where it is: a Rust
listing pasted into a `.cpp` file is worse than no offer at all. The Problems pane works the same either way,
because the C++ build publishes `arduino-cli`'s own compiler errors there.

The conversation follows the newest row while you are at the bottom of it, and stops following the moment you
scroll up to re-read something; asking a question starts following again.
Follow-up questions keep the thread.

**If an answer contains Rust code, a button appears under it: "Implement `fn flash_led` in the project…"**
(one per block, labelled by the item it defines). Pressing it writes that code into the Rust file you have
open — replacing the function of the same name where there is one, adding it to the file where there is not,
and replacing the file only when the answer is a whole file (it starts with `#![…]` or has `use` lines beside
`fn main`) — which asks first, in a dialog that names the file, because that shape is exactly how a file
silently loses everything the model did not reproduce. Your file's own attributes and signature are kept, so a
refactored `main` cannot lose `#[embassy_executor::main]`. The result opens as a **diff** and nothing is written
until you press **Apply** — the same review step as §4. No Rust file open? It asks which file, or offers to
create one.

### What will not be applied, and what the dialog offers instead

A model that quotes the line it is talking about — `async fn main(spawner: Spawner) {9` — is answering *about*
your code, not with a change to it. Every answer is therefore checked before anything is proposed:

| The answer | What the extension does |
|---|---|
| leaves code out (`...`, `// ...`, "rest of the function") | refused: applying it would delete what the placeholder stands for |
| does not close what it opens (`{` with no `}`) | refused, and its button is labelled `fn main (excerpt)` so the two blocks of a before/after answer can be told apart |
| is a fragment (statements with no item around them) | refused: there is nowhere in the file it could go |
| replaces a function with a fraction of it | **asks first**, by name and with the numbers (`replaces 11 lines of fn main with 3`) |
| is a whole file with items missing from it | refused, naming the items it dropped |

A refusal is not a dead end. It offers the way out that fits the answer:

- **Apply the complete block** — the same answer usually carries the whole function further down; if it does,
  the refusal names it and applies *that* (through the same diff, with the same confirmation).
- **Fix just that line** — the compiler's own first error, fixed one line at a time (see §5). This is the one to
  use when the model will not reproduce the function.
- **Ask for it in full** — sends the question that asks for the whole function, in those words: every line, no
  placeholders, and what leaving code out costs.

## 4. Review and apply

The answer opens as a **diff** — your file on the left, the proposed file on the right. Then:

- Click **Apply** to write it (or run **Rusty AI: Apply the Proposed Change**).
- Click **Discard** to throw it away.
- Or edit the proposal in the diff before applying — nothing is written until you say so.

After applying, the extension offers **Check (cargo check)**. Run **Rusty AI: Check the Project (cargo
check)** at any time; the errors land on the lines the compiler meant.

If you would rather skip the review, turn off **Show a diff before applying**
(`rustyPlatform.assistant.showDiff`). The edit is still a normal, undoable edit.

## 5. Fix build errors with it

Run **Rusty AI: Fix the Build…**. It:

1. runs `cargo check` and takes the **first** error,
2. rewrites the function the error points at (the error text is the instruction),
3. rebuilds, keeps the fix if the project got closer to compiling, and **undoes it if it did not**,
4. skips what nothing can fix, tries the next error, and lists what is left.

Alternatively, put the caret on a squiggle and pick **Fix with the AI assist** from the Quick Fix menu — or
**Fix this line with the AI assist**, which is explained next.

## 5a. Fix one line

The whole-function flows above need the model to reproduce the function, and a small model sometimes answers
with the change and `// ... rest of the function` for the rest — or with a quote of the line. **Fix this line**
sidesteps that: the answer is one line, and it replaces exactly the line the compiler points at.

Put the caret on a squiggle and press **`Ctrl+.`**, then pick **Fix this line with the AI assist**. It:

1. reads the line and the compiler's message about it (two lines either side are sent as context only, and the
   enclosing function is deliberately **not** sent — a model shown a function rewrites it);
2. asks a *patcher* — "reply with the corrected version of that ONE line and nothing else" — with a greedy,
   200-token budget, so a function cannot come back even if the model would like to write one;
3. reads the reply as exactly one line (a fence is unwrapped; two lines, a placeholder or `CANNOT FIX` are
   refused rather than trimmed);
4. checks the substitute against the line it replaces: the bracket balance must be the same, so a one-line edit
   can never unbalance the file below it, and a stripped indentation is put back;
5. opens the result as the usual **diff** — one line out, one line in.

Where one line is genuinely not enough (a missing `match` arm, a type that needs a new item), it says so, and
**Fix with the AI assist** from the same menu is the one to use.

The 200-token budget applies to this request only: **Longest answer** in the settings still decides every other
question, including the chat's.

## 6. Teach it your house rules

Run **Rusty AI: Learn the House Rules from My Code…**. The extension counts this project's own idioms
(indentation, `pub` on helpers, `?` versus `.unwrap()`, `defmt` logging, doc comments, constant and type
naming, `#[cfg(test)]` modules), shows the evidence next to each one (*"41 of 41 functions"*), and keeps the
ones you tick. Accepted rules go into **every** prompt afterwards — the chat's and the editor's own flows alike.
They live in `rustyPlatform.assistant.conventions`, and you can add rules by hand in the same setting (or in the
panel's own rules editor) alongside the measured ones. Nothing reads `AGENTS.md`: if you want a rule followed,
it has to be in this setting.

The measurement is Rust's: the counters look for Rust idioms, so a C++ project produces no measured rules. Rules
you write by hand in `rustyPlatform.assistant.conventions` are sent either way, which is the way to state a
sketch's house style.

## 6a. Code Assist in a sketch

**Rust Assist** watches for `//~ keyword` in the active editor, and in a C++ project that includes `.cpp`, `.c`
and `.ino` files. The keyword is answered in the language of the *file* it was typed in, so a `.rs` file gets the
Rust examples wherever it lives and a `.cpp` file gets C++ ones:

| `//~` | What comes back |
|---|---|
| `struct` | a plain struct, one with default member initialisers, one with a constructor, an aggregate built in place |
| `class` | public method and private state; a constructor with a static factory |
| `switch` | a statement switch, and several labels for one arm |
| `for` | counting up, counting down, over a fixed array, range-for |
| `while` | a plain while, do/while, and a bounded wait that cannot block forever |
| `if` | simple, if/else, else-if chain, and the guard clause |
| `fn` | a free function, a reference argument, a `const char *` argument, a `static` helper |
| `lvgl` | the four calls every widget starts with, a style on one object, an event callback, and `loop()` driving `lv_timer_handler()` |

The examples are compiled-in text, not a model call: they are the same every time, cost nothing, and are a
starting point to edit rather than an answer to review.

## Commands

The two that matter outside this document: **Rusty AI: Open the Assistant in an Editor Tab** (see §3) and
**Rusty AI: Add a Model from Hugging Face…** (see §2).

| Command (Command Palette → `Rusty AI:`) | What it does |
|---|---|
| **Open the Assistant Panel** | Focus the AI Assist view |
| **Open the AI Assist Settings** | Focus the view **and expand its settings section** |
| **Implement in Function…** | Insert the `✎ AI` block at the caret |
| **Fix the Build…** | `cargo check`, then fix the errors one at a time |
| **Fix This Line with AI** | Replace the one line a diagnostic points at (§5a; offered on the diagnostic itself) |
| **Check the Project (cargo check)** | Compile and publish the diagnostics |
| **Learn the House Rules from My Code…** | Measure the project's idioms and keep the ones you choose |
| **Choose a Local Model…** | Pick and set up a model (downloads if needed) |
| **Unload the Loaded Model** | Free the model's memory |
| **Status and Hardware Check** | What is configured, and what this machine can run |

Two commands have no palette entry because they are offered where you need them — **Send the Prompt in the
✎ AI Block** (`Ctrl+Alt+Enter`) and **Discard the ✎ AI Block** (`Ctrl+Alt+Escape`), plus **Apply/Discard the
Proposed Change** on the diff and **Fix This Line with AI** on a diagnostic's Quick Fix menu (it needs a
diagnostic as its argument, which the palette cannot supply).

## Settings (`rustyPlatform.assistant.*`)

Beyond the model and endpoint, these decide the *engine*: `llamaServerPath` (your `llama-server` binary, empty
= find it), `llamaServerModelPath` (the `.gguf` **your** server runs — kept apart from `modelPath`, which is the
built-in runtime's), `llamaServerArgs`, `llamaServerService` and `llamaServerStartTarget` (systemd unit on Linux
by default, a child process elsewhere), plus `gpuVramGb` for a card the extension cannot detect and
`loadContextLength` / `loadGpu` / `loadTtlSeconds` for what **Load Model** asks for.

| Setting | Default | What it decides |
|---|---|---|
| `backend` | `off` | `off`, `external` (a server you run) or `bundled` (the extension's own runtime) |
| `endpoint` | `http://127.0.0.1:1234/v1` | The OpenAI-compatible base URL used with `external` |
| `model` | *(empty)* | Model id to ask for; empty lets the server pick |
| `showDiff` | `true` | Review the proposal before it is written |
| `verifyAfterApply` | `true` | Offer a `cargo check` after a proposal is applied |
| `maxTokens` | `4096` | The longest answer the local model may write (the one-line fix is capped at 200 regardless) |
| `temperature` | `0.2` | Sampling temperature — low is right for code |
| `timeoutSeconds` | `60` | How long the model may go **without producing anything** before the request is treated as dead |
| `conventions` | `[]` | The house rules you accepted |
| `ignoreHostCheck` | `false` | Run local inference even when the hardware check says this machine is too small |
| `modelPath`, `threads`, `contextSize`, `gpuLayers`, `bundledBackend` | | The bundled runtime's model and how it is started |

## What leaves your machine

Nothing. The assistant is a **local** one, and that is the whole of its contract:

- **The bundled runtime runs on this machine**, and a server you point `endpoint` at is one you chose
  (LM Studio, Ollama, or your own `llama-server`).
- **No code, prompt or answer is sent anywhere else.** There is no cloud provider to configure, no API key to
  store, and no agent to hand a job to.
- **Nothing is started until you turn the switch on**, and switching it off unloads the models and stops the
  `llama-server`.

## Two things the assistant will not do

- **Change a function's attributes or signature.** `#[embassy_executor::main]`, `#[embassy_executor::task]`,
  the parameters and the return type come from your function, not from the model. Only the body is rewritten
  — which is why a dropped attribute cannot silently break your firmware.
- **Invent hardware.** The prompt carries the board profile (the LED really is on the CYW43 on a Pico W, and
  a Sunton board's panel really is on those SPI pins) and the crates your `Cargo.toml` lists. A pin or a
  crate that is not in there does not exist as far as the model is told.
