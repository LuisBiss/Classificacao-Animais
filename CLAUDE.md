# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Animal image classifier and object detector. Vanilla HTML/CSS/JS — there is no build step or app server: TensorFlow.js runs **inference in the browser**. There is, however, a required static file server (`serve.ps1`) and binary model artifacts (`weights.bin`), so it is not a pure single-file app — the model must be fetched over HTTP. UI text and code comments are in Portuguese (pt-BR).

Two local ML models run in the browser, plus an optional cloud LLM:
- **Teachable Machine model** (local `model.json` + `weights.bin`): classifies 9 animal classes. Powers the Upload, Webcam, and Avaliação (evaluation) tabs.
- **COCO-SSD / SSD MobileNet** (loaded lazily from CDN): object detection with bounding boxes. Powers the Detecção tab. Covers only 6 of the 9 classes (dog, horse, elephant, cat, cow, sheep).
- **Groq generative AI** (`meta-llama/llama-4-scout-17b-16e-instruct`, cloud, optional): complements the local prediction by verifying it and writing a rich description. Triggered three ways — manually on the Upload tab (button), and automatically from the Webcam and Detecção tabs (results appended to a dedicated **Histórico IA** tab). Requires running through `serve.ps1`/`serve.py` (which proxies the call and injects the API key) — see "Groq integration" below. This is the only feature that is *not* purely client-side.

## Running

No build/lint/test tooling exists. The model **cannot** be loaded via `file://` — a local HTTP server is required to `fetch` `model.json`/`weights.bin`.

There are two equivalent servers — `serve.ps1` (Windows/PowerShell) and `serve.py` (cross-platform, used on Linux/macOS). Both do the same two things: (1) serve static files, and (2) expose `POST /api/groq`, which injects the `API_KEY` as the `Authorization` header and forwards to the Groq API (so the key never reaches the browser). Both also load a local `.env` file (`API_KEY=gsk_...`) into the process environment; an already-exported shell var takes precedence. Keep them in sync when changing proxy behavior.

```bash
# Linux/macOS — reads API_KEY from .env (or the shell), serves on http://localhost:8080
python3 serve.py
```
```powershell
# Windows — same, via PowerShell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Gotchas learned the hard way:
- **The `.env` is git-ignored** (holds the real key). The browser cannot read it directly — the proxy is what bridges it.
- **Groq is behind Cloudflare**, which returns HTTP 403 `error code: 1010` to default bot user-agents. Both servers send a custom `User-Agent` to get past it — don't remove it.
- A plain static server (`python3 -m http.server`) serves the **local-model features** fine but has no `/api/groq`, so the Groq button will error.

## Architecture

Everything lives in 3 source files plus 3 model assets:

- `index.html` — single page, five tab panels (`panel-upload`, `panel-webcam`, `panel-eval`, `panel-detect`, `panel-feed`). DOM is wired with inline `onclick=` handlers calling global functions in `app.js`. CDN `<script>` tags at the bottom load tfjs 1.3.1, @teachablemachine/image 0.8, and @tensorflow-models/coco-ssd 2.2.2 (pinned versions) before `app.js`.
- `app.js` — all logic, organized into commented sections: classification/webcam, the Groq generative complement, model evaluation, and COCO-SSD detection. Functions are global (called from inline HTML handlers). Module state is module-scoped `let` vars (`model`, `cocoModel`, `webcamStream`, `detStream`, `evalImageStore`, `lastTopPrediction`, `lastImageForGroq`, etc.).
- `style.css` — dark-mode glassmorphism UI.
- `model.json`, `weights.bin`, `metadata.json` — exported Teachable Machine model (see "Model assets" below). `metadata.json` `labels` array and the `CLASSES`/`CLASS_EMOJIS` constants in `app.js` must stay in sync.

### Model assets

These are generated artifacts (exported from Teachable Machine), not hand-edited. To change classes/accuracy, retrain in Teachable Machine and re-export all three files together — do not edit `weights.bin` or `model.json` by hand.

- `model.json` (~90 KB) — Keras `Sequential` topology (tfjs-layers 1.7.4) plus a `weightsManifest` pointing at `weights.bin`. Architecture is **MobileNet transfer learning**: a frozen MobileNet feature extractor (224×224 input → 1280-d embedding via `GlobalAveragePooling2D`) followed by a trained head `Dense(100, relu)` → `Dense(9, softmax)`.
- `weights.bin` (~2.1 MB) — raw little-endian float32 weight buffer for all 263 tensors (≈539K floats); the bulk is the frozen MobileNet backbone. Loaded by the tfjs runtime, not by app code.
- `metadata.json` — `labels` (the 9 class names, order-significant), `imageSize` (224), and tfjs/TM version stamps.

### Key conventions

- **Class list is duplicated** in `app.js` (`CLASSES`, `CLASS_EMOJIS`) and `metadata.json` (`labels`). Changing the model means updating both, in the same order.
- **Tabs**: `switchTab(tab)` toggles `.active`/`.hidden` on `tab-<name>`/`panel-<name>` elements and stops any running webcam loop when leaving Webcam or Detecção tabs.
- **Evaluation** (`runEvaluation` → `computeMetrics`): builds an N×N confusion matrix where `cm[i][j]` = images of real class `i` predicted as `j`. Global metrics use **macro-averaging** over classes that have support. Color thresholds: ≥75% good, 50–74% medium, <50% poor (`colorClass`/`fmtPct`). Results exportable as JSON via `exportReport`.
- **Bounding box alignment** (the trickiest part): detection runs on the original `<img>`/`<video>` (natural coordinates), then boxes are drawn on a transparent `<canvas>` overlay sized to the wrapper container. Coordinates are mapped manually by computing the `object-fit` scale + center offset from `wrap.clientWidth/Height` — `contain` for image mode (`runDetectImage`), `cover` for webcam mode (`detectionLoop`). Do not switch to measuring the `<img>`/`<video>` element directly; that breaks alignment.
- **COCO-SSD labels** are translated to Portuguese via the `COCO_PT` map; detections below 0.30 confidence are filtered out in `renderDetResults`. COCO-SSD is loaded on first open of the Detecção tab (`ensureCocoModel`), not at startup.
- Webcam classification polls every 800ms (`setInterval`); detection webcam loops via `requestAnimationFrame` throttled to ~10 FPS (100ms gate).

### Groq integration

The "Complementar com IA (Groq)" button (`#btn-groq` in the shared `results-section`, `index.html:319`) sends the last **still** image plus the local top prediction to Groq for verification + a Portuguese description. The request makes **two hops**: browser → local proxy (`/api/groq`) → Groq. The browser never sees the API key — the proxy injects it server-side.

**Where it's wired** (all in `app.js`):
- Constants: `GROQ_PROXY_URL = '/api/groq'`, `GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'` (`app.js:14-15`).
- State (module-scoped): `lastImageForGroq` (data URL of the last still image) and `lastTopPrediction` (top class object). Both are required — `complementWithGroq` bails with "Classifique uma imagem primeiro." if either is null (`app.js:308-312`).
- `lastImageForGroq` is set **only** in `classifyUpload` (`app.js:136`); `lastTopPrediction` is set in `showResults` for **every** prediction (`app.js:219`, including webcam frames). The Upload-only scoping is enforced by the image gate, not the prediction gate.

**The request (how & in what form)** — `complementWithGroq` (`app.js:308-373`):
1. Downscales the still to ≤768px and re-encodes as JPEG quality 0.85 via `prepareImageForGroq` (`app.js:376`) — Groq caps base64 images at 4 MB.
2. Builds an OpenAI-compatible chat-completions body: `model: GROQ_MODEL`, `temperature: 0.4`, `max_tokens: 700`, `response_format: { type: 'json_object' }`, a `system` message (pt-BR zoologist, "respond ONLY with valid JSON"), and a multimodal `user` message — a `text` part (states the local class + confidence %, requests JSON with exact keys `confirma`/`animal`/`especie_raca`/`descricao`) plus an `image_url` part holding the base64 data URL.
3. `POST`s it as JSON to `GROQ_PROXY_URL`. On `!resp.ok` it throws `json.error.message` (or `Erro <status>…`); on success it reads `choices[0].message.content` and calls `renderGroqResult`.
4. `renderGroqResult` (`app.js:395`) `JSON.parse`s the content into a verdict card (✓ concorda / ✗ diverge), espécie/raça row, and descrição; on parse failure it falls back to rendering the raw text.

**The proxy** (`serve.py` `do_POST` / `serve.ps1` `/api/groq` block — keep in sync):
- Only `POST /api/groq` is dynamic; everything else is static file serving. Other methods/paths → 404.
- Reads the request body verbatim, adds `Authorization: Bearer <API_KEY>` + `Content-Type: application/json` + `User-Agent: ClassificadorAnimais/1.0`, and forwards to `https://api.groq.com/openai/v1/chat/completions` (`GROQ_ENDPOINT`). The custom User-Agent is mandatory — Groq's Cloudflare returns 403 `error code: 1010` to default `urllib`/PowerShell agents.
- `API_KEY` comes from the environment or the git-ignored `.env` (env var wins; `.env` is `setdefault`). If unset → HTTP 500 with `{"error":{"message":"API_KEY nao definida no servidor…"}}`, which surfaces in the Groq card as the error message.
- Upstream `HTTPError` is relayed with Groq's own status + body; any other failure → HTTP 502 `{"error":{"message":"Falha ao contatar a Groq: …"}}`. Both responses are always JSON so the browser's `json.error.message` path works.
- `serve.ps1` additionally forces TLS 1.2 (`ServicePointManager.SecurityProtocol`) — Windows PowerShell 5.1 doesn't default to it and Groq requires it.

**Tab scoping & lifecycle (Upload button)**: `showResults(predictions, isLive)` hides the Groq section when `isLive` is true **or** when `lastImageForGroq` is null (so it never fires per-frame or on the webcam tab). It's intentionally *not* set on the webcam path: `captureAndClassify` resumes live classification in its `finally`, so a captured frame would re-hide the section ~800ms later. `switchTab` → `clearResults` nulls both `lastImageForGroq` and `lastTopPrediction` and hides the section.

**Shared Groq helpers** (refactored so all three modules share one path): `buildGroqPayload(localLabel, pct, dataURL)` builds the body; `postGroq(payload)` does the `fetch` + error throw; `callGroq(imageDataURL, localLabel, confidence)` chains `prepareImageForGroq` → build → post; `parseGroqData(content)` returns `{ ok, confirma, animal, raca, desc }` (or `{ ok:false, raw }`); `groqVerdictHtml(parsed, localLabel)` renders the card inner HTML. The Upload button (`complementWithGroq`) and the feed both call these.

**Automatic triggers → Histórico IA feed**: the Webcam and Detecção tabs can each fire **multiple** Groq calls, so their results are appended (newest first) to the `panel-feed` tab instead of the shared `results-section`. `sendToFeed({ source, thumb, localLabel, confidence })` (`app.js`) creates a loading card via `pushFeedEntry`, calls `callGroq`, then fills the card with `groqVerdictHtml` (or an error card). `updateFeedBadge` keeps the tab badge count + `pulse` (cleared when the feed tab is opened in `switchTab`); `clearFeed` empties it.
- **Webcam** (`maybeWebcamGroq`, called from `classifyVideoFrame`): fires only when the top class **changes to a different animal**, above `WEBCAM_GROQ_MIN_CONF` (0.60), and not while a call is in flight (`webcamGroqBusy`). To avoid bursts from live-classifier flicker, the new class must persist for `WEBCAM_STABLE_POLLS` (2) consecutive reads before counting as a real change (`webcamPendingClass`/`webcamPendingCount`). `lastWebcamGroqAnimal` tracks the last sent class and is reset on webcam start/stop and `clearFeed`. The sent image is the full current frame (`captureWebcamThumb`).
- **Detecção** (`accumulateDetGroq`, called from `detectionLoop`, webcam mode only): over a tumbling **1s window** (`DET_WINDOW_MS`), keeps the highest-scoring detection whose class is **unique in the frame** (count===1, score ≥ 0.30); on window close it sends **only if the category changed** vs. the last sent (`lastDetGroqClass`) — otherwise a stable scene would fire ~1 req/s and blow the 30k TPM limit. The crop is taken from the video at peak (`cropFromVideo`, natural coords). Guarded by `detGroqBusy`; window + dedup state reset on det-webcam start/stop and `clearFeed`. Image-mode detection does **not** trigger Groq.
- **Rate-limit handling**: dedup-by-change is the only throttle (no global min-interval/backoff, by design). A 429 / "Rate limit" response is shown as a soft `groq-warn` card (not a red error), and dedup state is **not** reverted on failure so a failed attempt never spams the same category.
