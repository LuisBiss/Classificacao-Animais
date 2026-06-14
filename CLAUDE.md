# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Animal image classifier and object detector. Vanilla HTML/CSS/JS — there is no build step or app server: TensorFlow.js runs **inference in the browser**. There is, however, a required static file server (`serve.ps1`) and binary model artifacts (`weights.bin`), so it is not a pure single-file app — the model must be fetched over HTTP. UI text and code comments are in Portuguese (pt-BR).

Two local ML models run in the browser, plus an optional cloud LLM:
- **Teachable Machine model** (local `model.json` + `weights.bin`): classifies 9 animal classes. Powers the Upload, Webcam, and Avaliação (evaluation) tabs.
- **COCO-SSD / SSD MobileNet** (loaded lazily from CDN): object detection with bounding boxes. Powers the Detecção tab. Covers only 6 of the 9 classes (dog, horse, elephant, cat, cow, sheep).
- **Groq generative AI** (`meta-llama/llama-4-scout-17b-16e-instruct`, cloud, optional): on the Upload-tab result, complements the local prediction by verifying it and writing a rich description. Requires running through `serve.ps1` (which proxies the call and injects the API key) — see "Groq integration" below. This is the only feature that is *not* purely client-side.

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

- `index.html` — single page, four tab panels (`panel-upload`, `panel-webcam`, `panel-eval`, `panel-detect`). DOM is wired with inline `onclick=` handlers calling global functions in `app.js`. CDN `<script>` tags at the bottom load tfjs 1.3.1, @teachablemachine/image 0.8, and @tensorflow-models/coco-ssd 2.2.2 (pinned versions) before `app.js`.
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

The "Complementar com IA (Groq)" button (in the shared `results-section`) sends the last **still** image plus the local top prediction to Groq for verification + a Portuguese description. Flow:

- `app.js` builds an OpenAI-compatible chat-completions body (model `GROQ_MODEL`, `response_format: json_object`, system + multimodal user message with a base64 `image_url`) and `fetch`es the local proxy `GROQ_PROXY_URL` (`/api/groq`). It never sees the API key.
- `serve.ps1` adds `Authorization: Bearer $env:API_KEY` and forwards to `https://api.groq.com/openai/v1/chat/completions`, returning the response (or a JSON error if `API_KEY` is unset / Groq fails).
- The image is downscaled to ≤768px JPEG (`prepareImageForGroq`) before sending — Groq caps base64 images at 4 MB.
- Scoped to the **Upload tab**: `lastImageForGroq` is set only in `classifyUpload`. It is intentionally *not* set on the webcam path — `captureAndClassify` resumes live classification in its `finally`, so a live frame would re-hide the section ~800ms later. `showResults(predictions, isLive)` hides the Groq section when `isLive` is true or when `lastImageForGroq` is null (so it never fires per-frame or on the webcam tab). `switchTab` → `clearResults` nulls the state when changing tabs.
- Groq is expected to return JSON (`confirma`, `animal`, `especie_raca`, `descricao`); `renderGroqResult` parses it and falls back to raw text if parsing fails.
