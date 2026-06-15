
/* ============================================================
   app.js — Classificador de Animais com Teachable Machine
   ============================================================ */

'use strict';

// ── Configuracoes ───────────────────────────────────────────
const MODEL_URL = './model.json';
const METADATA_URL = './metadata.json';
const IMAGE_SIZE = 224;

// Complemento com IA generativa — proxy local injeta a API_KEY (ver serve.ps1)
const GROQ_PROXY_URL = '/api/groq';
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// Disparos automaticos da IA nas abas Webcam e Deteccao (ver "Histórico IA")
const WEBCAM_GROQ_MIN_CONF = 0.60; // so dispara acima desta confianca ao vivo
const WEBCAM_STABLE_POLLS = 2;     // classe precisa persistir N leituras (anti-flicker)
const DET_WINDOW_MS = 1000;        // janela de 1s para escolher o melhor recorte

const CLASS_EMOJIS = {
  'Cachorro': '\uD83D\uDC36',
  'Cavalo': '\uD83D\uDC34',
  'Elefante': '\uD83D\uDC18',
  'Borboleta': '\uD83E\uDD8B',
  'Galinha': '\uD83D\uDC14',
  'Gato': '\uD83D\uDC31',
  'Vaca': '\uD83D\uDC04',
  'Ovelha': '\uD83D\uDC11',
  'Aranha': '\uD83D\uDD77\uFE0F',
};

// ── Estado global ───────────────────────────────────────────
let model = null;
let webcamStream = null;
let liveInterval = null;
let currentTab = 'upload';

// Complemento Groq: ultima predicao e imagem (still) classificada
let lastTopPrediction = null;
let lastImageForGroq = null; // data URL da ultima imagem fixa classificada

// Histórico IA (aba "feed") — disparos automaticos de Webcam e Deteccao
let feedCount = 0;
// Webcam: so dispara quando o animal de topo muda para um diferente
let lastWebcamGroqAnimal = null;
let webcamGroqBusy = false;
let webcamPendingClass = null; // classe candidata aguardando estabilizar
let webcamPendingCount = 0;    // leituras consecutivas da classe candidata
// Deteccao: janela de 1s guarda o melhor recorte de categoria unica
let detWindowStart = 0;
let detWindowBest = null;  // { score, class, crop }
let detGroqBusy = false;
let lastDetGroqClass = null; // ultima categoria enviada (dedup por mudanca)

// Evaluation state
let evalImageStore = {};   // { className: [{ file, imgEl }] }
let lastEvalReport = null; // stores last computed report
const CLASSES = ['Cachorro', 'Cavalo', 'Elefante', 'Borboleta', 'Galinha', 'Gato', 'Vaca', 'Ovelha', 'Aranha'];

// ── Inicializacao ────────────────────────────────────────────
(async function init() {
  showLoading('Carregando modelo de IA...');
  try {
    model = await tmImage.load(MODEL_URL, METADATA_URL);
    console.log('[Classificador] Modelo carregado. Classes:', model.getTotalClasses());
    buildEvalGrid();
  } catch (err) {
    console.error('[Classificador] Erro ao carregar modelo:', err);
    showError('Nao foi possivel carregar o modelo. Certifique-se de abrir via servidor local.');
  } finally {
    hideLoading();
  }
})();

// ── Navegacao entre abas ─────────────────────────────────────
function switchTab(tab) {
  if (tab === currentTab) return;
  if (currentTab === 'webcam' && tab !== 'webcam') stopWebcam();
  currentTab = tab;

  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.remove('active');
    p.classList.add('hidden');
  });

  const activeTab = document.getElementById(`tab-${tab}`);
  const activePanel = document.getElementById(`panel-${tab}`);
  activeTab.classList.add('active');
  activeTab.setAttribute('aria-selected', 'true');
  activePanel.classList.remove('hidden');
  activePanel.classList.add('active');

  if (tab !== 'eval') clearResults();
  // Stop detection webcam if leaving the detect tab
  if (tab !== 'detect') stopDetWebcam();
  // Ao abrir o Histórico IA, para de pulsar o aviso de novas análises
  if (tab === 'feed') {
    const badge = document.getElementById('feed-tab-badge');
    if (badge) badge.classList.remove('pulse');
  }
}

// ── Upload de imagem ─────────────────────────────────────────
function handleDragOver(e, zoneId) {
  e.preventDefault();
  const id = zoneId || 'drop-zone';
  document.getElementById(id).classList.add('drag-over');
}
function handleDragLeave(e, zoneId) {
  const id = zoneId || 'drop-zone';
  document.getElementById(id).classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadImageFile(file);
}
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (file) loadImageFile(file);
}
function loadImageFile(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    const img = document.getElementById('preview-img');
    img.src = ev.target.result;
    img.classList.remove('hidden');
    document.getElementById('drop-zone-content').classList.add('hidden');
    document.getElementById('btn-classify-upload').classList.remove('hidden');
    document.getElementById('btn-clear-upload').classList.remove('hidden');
    clearResults();
  };
  reader.readAsDataURL(file);
}
function clearUpload() {
  const img = document.getElementById('preview-img');
  img.src = '';
  img.classList.add('hidden');
  document.getElementById('drop-zone-content').classList.remove('hidden');
  document.getElementById('btn-classify-upload').classList.add('hidden');
  document.getElementById('btn-clear-upload').classList.add('hidden');
  document.getElementById('file-input').value = '';
  clearResults();
}
async function classifyUpload() {
  if (!model) { showError('Modelo ainda nao carregado.'); return; }
  const img = document.getElementById('preview-img');
  if (!img.src) return;
  const btn = document.getElementById('btn-classify-upload');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Classificando...';
  lastImageForGroq = img.src;
  try {
    showResults(await model.predict(img));
  } catch (err) {
    console.error(err);
    showError('Erro ao classificar a imagem.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">\uD83D\uDD0D</span> Classificar Imagem';
  }
}

// ── Webcam ────────────────────────────────────────────────────
async function startWebcam() {
  if (!model) { showError('Modelo ainda nao carregado.'); return; }
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
    const video = document.getElementById('webcam-video');
    video.srcObject = webcamStream;
    video.classList.remove('hidden');
    document.getElementById('webcam-placeholder').classList.add('hidden');
    document.getElementById('btn-start-webcam').classList.add('hidden');
    document.getElementById('btn-stop-webcam').classList.remove('hidden');
    document.getElementById('btn-capture').classList.remove('hidden');
    lastWebcamGroqAnimal = null;
    webcamPendingClass = null;
    webcamPendingCount = 0;
    startLiveClassification();
  } catch (err) {
    if (err.name === 'NotAllowedError') showError('Permissao de camera negada.');
    else showError('Nao foi possivel acessar a camera: ' + err.message);
  }
}
function stopWebcam() {
  stopLiveClassification();
  lastWebcamGroqAnimal = null;
  webcamPendingClass = null;
  webcamPendingCount = 0;
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  const video = document.getElementById('webcam-video');
  video.srcObject = null;
  video.classList.add('hidden');
  document.getElementById('webcam-placeholder').classList.remove('hidden');
  document.getElementById('btn-start-webcam').classList.remove('hidden');
  document.getElementById('btn-stop-webcam').classList.add('hidden');
  document.getElementById('btn-capture').classList.add('hidden');
  document.getElementById('webcam-live-indicator').classList.add('hidden');
  clearResults();
}
function startLiveClassification() {
  document.getElementById('webcam-live-indicator').classList.remove('hidden');
  liveInterval = setInterval(() => {
    const video = document.getElementById('webcam-video');
    if (video.readyState === 4) classifyVideoFrame(video);
  }, 800);
}
function stopLiveClassification() {
  if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
}
async function classifyVideoFrame(videoEl) {
  if (!model || !videoEl) return;
  let preds;
  try { preds = await model.predict(videoEl); } catch (e) { return; }
  showResults(preds, true);
  maybeWebcamGroq(preds);
}

// Dispara a Groq quando o animal de topo muda para um diferente. Para evitar
// rajadas pela oscilacao (flicker) do classificador ao vivo, a nova classe
// precisa persistir por WEBCAM_STABLE_POLLS leituras antes de contar como
// mudanca real. Acrescenta ao Histórico.
function maybeWebcamGroq(predictions) {
  if (!predictions || !predictions.length) return;
  const top = predictions.reduce((a, b) => a.probability > b.probability ? a : b);
  if (top.probability < WEBCAM_GROQ_MIN_CONF) {
    webcamPendingClass = null;
    webcamPendingCount = 0;
    return;
  }

  // Conta leituras consecutivas da mesma classe (estabilidade)
  if (top.className === webcamPendingClass) webcamPendingCount++;
  else { webcamPendingClass = top.className; webcamPendingCount = 1; }

  if (top.className === lastWebcamGroqAnimal) return;     // ja enviado p/ este animal
  if (webcamPendingCount < WEBCAM_STABLE_POLLS) return;   // ainda nao estabilizou
  if (webcamGroqBusy) return;                             // espera a chamada anterior

  lastWebcamGroqAnimal = top.className;
  webcamGroqBusy = true;
  const thumb = captureWebcamThumb();
  sendToFeed({ source: 'webcam', thumb, localLabel: top.className, confidence: top.probability })
    .finally(() => { webcamGroqBusy = false; });
}

// Captura o frame atual da webcam como JPEG (data URL) para enviar a Groq.
function captureWebcamThumb() {
  const video = document.getElementById('webcam-video');
  const c = document.createElement('canvas');
  c.width = video.videoWidth || IMAGE_SIZE;
  c.height = video.videoHeight || IMAGE_SIZE;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
async function captureAndClassify() {
  const video = document.getElementById('webcam-video');
  if (!video || !model) return;
  stopLiveClassification();
  const canvas = document.getElementById('webcam-canvas');
  canvas.width = video.videoWidth || IMAGE_SIZE;
  canvas.height = video.videoHeight || IMAGE_SIZE;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const btn = document.getElementById('btn-capture');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Classificando...';
  try { showResults(await model.predict(canvas)); } catch (err) { showError('Erro ao classificar frame.'); }
  finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">\uD83D\uDCF8</span> Capturar e Classificar';
    startLiveClassification();
  }
}

// ── Exibicao de resultados ────────────────────────────────────
function showResults(predictions, isLive = false) {
  if (!predictions || !predictions.length) return;
  const sorted = [...predictions].sort((a, b) => b.probability - a.probability);
  const best = sorted[0];
  lastTopPrediction = best;
  document.getElementById('results-section').classList.remove('hidden');
  document.getElementById('top-emoji').textContent = CLASS_EMOJIS[best.className] || '\uD83D\uDC3E';
  document.getElementById('top-label').textContent = best.className;
  document.getElementById('top-confidence').textContent = `Confianca: ${(best.probability * 100).toFixed(1)}%`;

  const container = document.getElementById('bars-container');
  container.innerHTML = '';
  sorted.forEach((pred, idx) => {
    const pct = (pred.probability * 100).toFixed(1);
    const isBest = idx === 0;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.style.animationDelay = `${idx * 60}ms`;
    row.innerHTML = `
      <span class="bar-label${isBest ? ' best' : ''}">${CLASS_EMOJIS[pred.className] || ''} ${pred.className}</span>
      <div class="bar-track"><div class="bar-fill${isBest ? ' best' : ''}" data-pct="${pred.probability * 100}" style="width:0%"></div></div>
      <span class="bar-pct${isBest ? ' best' : ''}">${pct}%</span>`;
    container.appendChild(row);
  });
  requestAnimationFrame(() => {
    document.querySelectorAll('.bar-fill').forEach(fill => {
      setTimeout(() => { fill.style.width = `${fill.dataset.pct}%`; }, 50);
    });
  });

  // Complemento Groq: disponivel apenas em imagens fixas (nao no fluxo ao vivo)
  const groqSection = document.getElementById('groq-section');
  const groqResult = document.getElementById('groq-result');
  if (isLive || !lastImageForGroq) {
    groqSection.classList.add('hidden');
  } else {
    groqSection.classList.remove('hidden');
    groqResult.classList.add('hidden');
    groqResult.innerHTML = '';
    const gbtn = document.getElementById('btn-groq');
    gbtn.disabled = false;
    gbtn.innerHTML = '<span class="btn-icon">🤖</span> Complementar com IA (Groq)';
  }
}
function clearResults() {
  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('bars-container').innerHTML = '';
  document.getElementById('top-label').textContent = '—';
  document.getElementById('top-confidence').textContent = '—';
  document.getElementById('top-emoji').textContent = '\uD83D\uDC3E';

  // Reseta o complemento Groq
  const groqSection = document.getElementById('groq-section');
  if (groqSection) groqSection.classList.add('hidden');
  const groqResult = document.getElementById('groq-result');
  if (groqResult) { groqResult.classList.add('hidden'); groqResult.innerHTML = ''; }
  lastTopPrediction = null;
  lastImageForGroq = null;
}

// ── Loading / Erros ───────────────────────────────────────────
function showLoading(msg = 'Carregando...') {
  document.getElementById('loading-text').textContent = msg;
  document.getElementById('loading-overlay').classList.remove('hidden');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}
function showError(msg) {
  hideLoading();
  const old = document.getElementById('error-toast');
  if (old) old.remove();
  const toast = document.createElement('div');
  toast.id = 'error-toast';
  toast.style.cssText = `
    position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);
    background:rgba(239,68,68,0.92);color:#fff;
    padding:0.75rem 1.5rem;border-radius:12px;
    font-size:0.9rem;font-weight:500;z-index:9999;
    backdrop-filter:blur(8px);box-shadow:0 8px 32px rgba(0,0,0,0.4);
    max-width:90vw;text-align:center;animation:fadeUp 0.3s both;`;
  toast.textContent = '\u26A0\uFE0F ' + msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5500);
}

// =============================================================
//   COMPLEMENTO COM IA GENERATIVA (Groq \u00B7 Llama 4 Scout)
// =============================================================
// Envia a imagem ja reconhecida pelo modelo local + a predicao para a Groq,
// que confirma/corrige a identificacao e gera uma descricao rica. A chamada
// passa pelo proxy local /api/groq, que injeta a API_KEY (ver serve.ps1).

// Monta o corpo OpenAI-compatible enviado ao proxy /api/groq. O texto e
// parametrizado pelo rotulo local (modelo TM ou COCO-SSD) e sua confianca.
function buildGroqPayload(localLabel, pct, dataURL) {
  return {
    model: GROQ_MODEL,
    temperature: 0.4,
    max_tokens: 700,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Voc\u00EA \u00E9 um zo\u00F3logo especialista em identifica\u00E7\u00E3o de animais. Responda SEMPRE em portugu\u00EAs do Brasil e SOMENTE com um objeto JSON v\u00E1lido, sem texto adicional.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Um modelo local classificou esta imagem como "${localLabel}" com ${pct}% de confian\u00E7a. ` +
              `Analise a imagem e responda em JSON com as chaves exatas: ` +
              `"confirma" (booleano \u2014 true se o animal principal realmente \u00E9 ${localLabel}, sen\u00E3o false), ` +
              `"animal" (string \u2014 o animal que voc\u00EA de fato v\u00EA), ` +
              `"especie_raca" (string \u2014 esp\u00E9cie ou ra\u00E7a prov\u00E1vel), ` +
              `"descricao" (string \u2014 2 a 3 frases com caracter\u00EDsticas marcantes e uma curiosidade). ` +
              `Responda apenas com o JSON.`,
          },
          { type: 'image_url', image_url: { url: dataURL } },
        ],
      },
    ],
  };
}

// Faz o POST ao proxy local e devolve o texto da resposta (ou lanca erro).
async function postGroq(payload) {
  const resp = await fetch(GROQ_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(json?.error?.message || `Erro ${resp.status} ao consultar a Groq.`);
  }
  return json?.choices?.[0]?.message?.content || '';
}

// Faz a chamada completa: prepara a imagem, monta payload e devolve o texto.
async function callGroq(imageDataURL, localLabel, confidence) {
  const dataURL = await prepareImageForGroq(imageDataURL, 768);
  const pct = (confidence * 100).toFixed(1);
  return postGroq(buildGroqPayload(localLabel, pct, dataURL));
}

// Interpreta a resposta JSON da Groq (com fallback para texto cru).
function parseGroqData(content) {
  try {
    const d = JSON.parse(content);
    return {
      ok: true,
      confirma: d.confirma === true || /^(sim|true|verdadeiro)$/i.test(String(d.confirma).trim()),
      animal: d.animal || '\u2014',
      raca: d.especie_raca || d.especie || d.raca || '',
      desc: d.descricao || '',
    };
  } catch (e) {
    return { ok: false, raw: content };
  }
}

// Gera o conteudo interno de um card da Groq (compartilhado: Upload + Hist\u00F3rico).
function groqVerdictHtml(parsed, localLabel) {
  let badge = '';
  let rows = '';
  if (parsed.ok) {
    badge = parsed.confirma
      ? `<span class="groq-badge ok">\u2713 Groq concorda: ${escapeHtml(localLabel)}</span>`
      : `<span class="groq-badge diff">\u2717 Groq diverge \u2014 v\u00EA: ${escapeHtml(parsed.animal)}</span>`;
    rows =
      (parsed.raca ? `<div class="groq-row"><strong>Esp\u00E9cie/Ra\u00E7a:</strong> ${escapeHtml(parsed.raca)}</div>` : '') +
      (parsed.desc ? `<p class="groq-desc">${escapeHtml(parsed.desc)}</p>` : '');
  } else {
    rows = `<p class="groq-desc">${escapeHtml(parsed.raw)}</p>`;
  }
  return `
    <div class="groq-card-head">
      <span class="groq-logo">\uD83E\uDD16 Groq \u00B7 Llama 4 Scout</span>
      ${badge}
    </div>
    ${rows}`;
}

async function complementWithGroq() {
  if (!lastImageForGroq || !lastTopPrediction) {
    showError('Classifique uma imagem primeiro.');
    return;
  }
  const btn = document.getElementById('btn-groq');
  const out = document.getElementById('groq-result');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">\u23F3</span> Analisando com IA...';
  out.classList.remove('hidden');
  out.innerHTML = '<div class="groq-loading"><span class="groq-spinner"></span> A IA est\u00E1 analisando a imagem\u2026</div>';

  try {
    const top = lastTopPrediction;
    const content = await callGroq(lastImageForGroq, top.className, top.probability);
    renderGroqResult(content, top);
  } catch (err) {
    console.error('[Groq]', err);
    out.innerHTML = `<div class="groq-error">\u26A0\uFE0F ${escapeHtml(err.message || 'Falha ao consultar a IA Groq.')}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">\uD83D\uDD04</span> Analisar novamente';
  }
}

// Redimensiona/recodifica a imagem para JPEG (mantem o envio < 4MB exigido pela Groq)
function prepareImageForGroq(dataURL, maxDim = 768) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('N\u00E3o foi poss\u00EDvel processar a imagem.'));
    img.src = dataURL;
  });
}

function renderGroqResult(content, top) {
  const out = document.getElementById('groq-result');
  out.innerHTML = `<div class="groq-card">${groqVerdictHtml(parseGroqData(content), top.className)}</div>`;
}

// =============================================================
//   HIST\u00D3RICO IA (aba "feed") \u2014 append das respostas da Groq
// =============================================================
// As abas Webcam e Deteccao podem disparar varias chamadas; cada resposta
// e acrescentada como um card aqui, sem substituir as anteriores.

// Cria um card em estado "carregando" no topo da lista e devolve o slot
// onde a resposta (ou erro) sera escrita.
function pushFeedEntry({ source, thumb, localLabel, confidence }) {
  const list = document.getElementById('feed-list');
  document.getElementById('feed-empty').classList.add('hidden');

  const meta = source === 'webcam'
    ? { cls: 'webcam', icon: '\uD83D\uDCF7', text: 'Webcam' }
    : { cls: 'detect', icon: '\uD83D\uDD0D', text: 'Detec\u00E7\u00E3o' };
  const time = new Date().toLocaleTimeString('pt-BR');
  const pct = (confidence * 100).toFixed(1);

  const card = document.createElement('div');
  card.className = 'feed-card';
  card.innerHTML = `
    <div class="feed-thumb"><img src="${thumb}" alt="${escapeHtml(localLabel)}" /></div>
    <div class="feed-body">
      <div class="feed-head">
        <span class="feed-source feed-source-${meta.cls}">${meta.icon} ${meta.text}</span>
        <span class="feed-time">${time}</span>
      </div>
      <div class="feed-local">Modelo local: <strong>${escapeHtml(localLabel)}</strong> \u00B7 ${pct}%</div>
      <div class="feed-groq groq-card">
        <div class="groq-loading"><span class="groq-spinner"></span> A IA est\u00E1 analisando\u2026</div>
      </div>
    </div>`;
  list.prepend(card);

  feedCount++;
  updateFeedBadge();
  return card.querySelector('.feed-groq');
}

function updateFeedBadge() {
  const total = document.getElementById('feed-total');
  if (total) total.textContent = feedCount;
  const badge = document.getElementById('feed-tab-badge');
  if (badge) {
    badge.textContent = feedCount;
    badge.classList.toggle('hidden', feedCount === 0);
    if (feedCount > 0 && currentTab !== 'feed') badge.classList.add('pulse');
  }
}

function clearFeed() {
  document.getElementById('feed-list').innerHTML = '';
  document.getElementById('feed-empty').classList.remove('hidden');
  feedCount = 0;
  updateFeedBadge();
  // Permite re-disparar a categoria atual depois de limpar o historico
  lastWebcamGroqAnimal = null;
  lastDetGroqClass = null;
}

// Ponto de entrada usado por Webcam e Deteccao: cria o card e o preenche
// quando a Groq responde. Erros viram um card de erro (nao quebram o loop).
async function sendToFeed(opts) {
  const slot = pushFeedEntry(opts);
  try {
    const content = await callGroq(opts.thumb, opts.localLabel, opts.confidence);
    slot.innerHTML = groqVerdictHtml(parseGroqData(content), opts.localLabel);
  } catch (err) {
    console.error('[Groq feed]', err);
    // Limite de uso (TPM/RPM) recebe um card informativo, nao de erro
    if (/rate limit|429/i.test(err.message || '')) {
      slot.innerHTML = '<div class="groq-warn">\u23F3 Limite de uso da IA atingido momentaneamente \u2014 tente novamente em alguns segundos.</div>';
    } else {
      slot.innerHTML = `<div class="groq-error">\u26A0\uFE0F ${escapeHtml(err.message || 'Falha ao consultar a IA Groq.')}</div>`;
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// =============================================================
//   AVALIACAO DO MODELO
// =============================================================

// ── Build class upload grid ───────────────────────────────────
function buildEvalGrid() {
  const grid = document.getElementById('eval-grid');
  grid.innerHTML = '';
  CLASSES.forEach(cls => {
    evalImageStore[cls] = [];

    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'file';
    hiddenInput.accept = 'image/*';
    hiddenInput.multiple = true;
    hiddenInput.id = `eval-input-${cls}`;
    hiddenInput.style.display = 'none';
    hiddenInput.addEventListener('change', e => handleEvalFiles(cls, e.target.files));
    document.body.appendChild(hiddenInput);

    const card = document.createElement('div');
    card.className = 'eval-class-card';
    card.id = `eval-card-${cls}`;
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Adicionar imagens de teste da classe ${cls}`);
    card.addEventListener('click', () => hiddenInput.click());
    card.addEventListener('keydown', e => { if (e.key === 'Enter') hiddenInput.click(); });
    card.innerHTML = `
      <span class="eval-class-emoji">${CLASS_EMOJIS[cls] || '\uD83D\uDC3E'}</span>
      <span class="eval-class-name">${cls}</span>
      <span class="eval-class-count" id="eval-count-${cls}">Clique para adicionar</span>
      <div class="eval-thumbnails" id="eval-thumbs-${cls}"></div>`;
    grid.appendChild(card);
  });
}

// ── Handle uploaded eval files ────────────────────────────────
function handleEvalFiles(cls, files) {
  if (!files || !files.length) return;
  let loaded = 0;
  Array.from(files).forEach(file => {
    if (!file.type.startsWith('image/')) return;
    const img = new Image();
    const reader = new FileReader();
    reader.onload = ev => {
      img.src = ev.target.result;
      img.onload = () => {
        evalImageStore[cls].push({ file, imgEl: img });
        loaded++;
        updateClassCard(cls);
        updateEvalSummary();
        if (loaded === Array.from(files).filter(f => f.type.startsWith('image/')).length) {
          img.onload = null; // cleanup
        }
      };
    };
    reader.readAsDataURL(file);
  });
}

function updateClassCard(cls) {
  const items = evalImageStore[cls];
  const card = document.getElementById(`eval-card-${cls}`);
  const count = document.getElementById(`eval-count-${cls}`);
  const thumbs = document.getElementById(`eval-thumbs-${cls}`);

  card.classList.toggle('has-files', items.length > 0);

  // Badge
  const oldBadge = card.querySelector('.eval-class-badge');
  if (oldBadge) oldBadge.remove();
  if (items.length > 0) {
    const badge = document.createElement('span');
    badge.className = 'eval-class-badge';
    badge.textContent = items.length;
    card.appendChild(badge);
  }

  count.textContent = items.length > 0 ? `${items.length} imagem(ns)` : 'Clique para adicionar';
  count.classList.toggle('loaded', items.length > 0);

  // Thumbnails (max 6)
  thumbs.innerHTML = '';
  items.slice(0, 6).forEach(({ imgEl }) => {
    const th = new Image();
    th.src = imgEl.src;
    th.className = 'eval-thumb';
    th.alt = cls;
    thumbs.appendChild(th);
  });
}

function updateEvalSummary() {
  const total = CLASSES.reduce((s, c) => s + evalImageStore[c].length, 0);
  const classCount = CLASSES.filter(c => evalImageStore[c].length > 0).length;
  document.getElementById('eval-total-count').textContent = `${total} imagem(ns) carregada(s)`;
  document.getElementById('eval-class-count').textContent = `${classCount}/9 classes`;
  document.getElementById('btn-evaluate').disabled = total === 0;
  document.getElementById('btn-clear-eval').classList.toggle('hidden', total === 0);
}

function clearEvaluation() {
  CLASSES.forEach(cls => {
    evalImageStore[cls] = [];
    updateClassCard(cls);
    const input = document.getElementById(`eval-input-${cls}`);
    if (input) input.value = '';
  });
  updateEvalSummary();
  document.getElementById('eval-results').classList.add('hidden');
  document.getElementById('eval-progress-wrap').classList.add('hidden');
  lastEvalReport = null;
}

// ── Run evaluation ─────────────────────────────────────────────
async function runEvaluation() {
  if (!model) { showError('Modelo nao carregado.'); return; }

  const total = CLASSES.reduce((s, c) => s + evalImageStore[c].length, 0);
  if (total === 0) { showError('Adicione imagens de teste primeiro.'); return; }

  // Disable button, show progress
  const btnEval = document.getElementById('btn-evaluate');
  btnEval.disabled = true;
  btnEval.innerHTML = '<span class="btn-icon">⏳</span> Avaliando...';

  document.getElementById('eval-results').classList.add('hidden');
  document.getElementById('eval-progress-wrap').classList.remove('hidden');

  const n = CLASSES.length;

  // confusionMatrix[i][j] = number of images from class i predicted as class j
  const confusionMatrix = Array.from({ length: n }, () => new Array(n).fill(0));

  let done = 0;

  for (let ci = 0; ci < n; ci++) {
    const cls = CLASSES[ci];
    const items = evalImageStore[cls];
    for (const { imgEl } of items) {
      let preds;
      try {
        preds = await model.predict(imgEl);
      } catch (e) {
        console.warn('predict error', e);
        done++;
        continue;
      }
      const predClass = preds.reduce((a, b) => a.probability > b.probability ? a : b).className;
      const pi = CLASSES.indexOf(predClass);
      if (pi >= 0) confusionMatrix[ci][pi]++;
      done++;
      const pct = Math.round((done / total) * 100);
      document.getElementById('eval-progress-fill').style.width = pct + '%';
      document.getElementById('eval-progress-pct').textContent = pct + '%';
      document.getElementById('eval-progress-label').textContent = `Classificando ${done}/${total}...`;
      // yield to allow UI update
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // ── Compute metrics ─────────────────────────────────────────
  const report = computeMetrics(confusionMatrix, total);
  lastEvalReport = { report, confusionMatrix, total, timestamp: new Date().toISOString() };

  // ── Render results ──────────────────────────────────────────
  renderMetrics(report, confusionMatrix);

  document.getElementById('eval-progress-wrap').classList.add('hidden');
  document.getElementById('eval-results').classList.remove('hidden');
  document.getElementById('eval-results').scrollIntoView({ behavior: 'smooth', block: 'start' });

  btnEval.disabled = false;
  btnEval.innerHTML = '<span class="btn-icon">\uD83E\uDDEA</span> Avaliar Novamente';
}

// ── Compute Accuracy, Precision, Recall, F1 per class & macro ─
function computeMetrics(cm, total) {
  const n = CLASSES.length;
  let correct = 0;
  for (let i = 0; i < n; i++) correct += cm[i][i];

  const accuracy = total > 0 ? correct / total : 0;

  const perClass = CLASSES.map((cls, i) => {
    const support = cm[i].reduce((s, v) => s + v, 0);     // real positives for class i
    const tp = cm[i][i];
    const fp = cm.reduce((s, row) => s + row[i], 0) - tp; // predicted as i but wrong
    const fn = support - tp;                               // real i but predicted wrong

    const precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
    const recall = support > 0 ? tp / support : null;
    const f1 = (precision !== null && recall !== null && (precision + recall) > 0)
      ? 2 * precision * recall / (precision + recall)
      : null;

    return { cls, tp, fp, fn, support, precision, recall, f1 };
  });

  // Macro averages (only over classes that have support)
  const classesWithSupport = perClass.filter(c => c.support > 0);
  const macroPrecision = avg(classesWithSupport.map(c => c.precision ?? 0));
  const macroRecall = avg(classesWithSupport.map(c => c.recall ?? 0));
  const macroF1 = avg(classesWithSupport.map(c => c.f1 ?? 0));

  return { accuracy, macroPrecision, macroRecall, macroF1, perClass };
}

function avg(arr) {
  return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ── Render metrics to DOM ──────────────────────────────────────
function renderMetrics(report, cm) {
  const { accuracy, macroPrecision, macroRecall, macroF1, perClass } = report;

  // Global metric cards
  setMetricCard('mv-accuracy', accuracy, 'mc-accuracy');
  setMetricCard('mv-precision', macroPrecision, 'mc-precision');
  setMetricCard('mv-recall', macroRecall, 'mc-recall');
  setMetricCard('mv-f1', macroF1, 'mc-f1');

  // Per-class table
  const tbody = document.getElementById('per-class-tbody');
  tbody.innerHTML = '';
  const bestF1 = Math.max(...perClass.map(c => c.f1 ?? -1));

  perClass.forEach(c => {
    const isBest = c.f1 !== null && Math.abs(c.f1 - bestF1) < 0.001;
    const tr = document.createElement('tr');
    if (isBest) tr.className = 'best-row';
    tr.innerHTML = `
      <td>${CLASS_EMOJIS[c.cls] || ''} <strong>${c.cls}</strong></td>
      <td>${fmtPct(c.precision)}</td>
      <td>${fmtPct(c.recall)}</td>
      <td>${fmtPct(c.f1)}</td>
      <td style="color:var(--text-muted)">${c.support}</td>`;
    tbody.appendChild(tr);
  });

  // Confusion matrix
  renderConfusionMatrix(cm);
}

function setMetricCard(valueId, value, cardId) {
  const el = document.getElementById(valueId);
  const pct = (value * 100).toFixed(1) + '%';
  el.textContent = pct;
  el.className = 'metric-value ' + colorClass(value);
  // animate number (count-up)
  countUpEl(el, value * 100);
}

function colorClass(v) {
  if (v >= 0.75) return 'good';
  if (v >= 0.50) return 'medium';
  return 'poor';
}

function countUpEl(el, target) {
  const steps = 40;
  const duration = 700;
  let step = 0;
  const interval = setInterval(() => {
    step++;
    const current = target * (step / steps);
    el.textContent = current.toFixed(1) + '%';
    if (step >= steps) { el.textContent = target.toFixed(1) + '%'; clearInterval(interval); }
  }, duration / steps);
}

function fmtPct(v) {
  if (v === null) return `<span class="pct-cell pct-na">N/A</span>`;
  const pct = (v * 100).toFixed(1);
  const cls = v >= 0.75 ? 'pct-good' : v >= 0.50 ? 'pct-medium' : 'pct-poor';
  return `<span class="pct-cell ${cls}">${pct}%</span>`;
}

// ── Confusion matrix render ─────────────────────────────────
function renderConfusionMatrix(cm) {
  const wrap = document.getElementById('confusion-matrix-wrap');
  wrap.innerHTML = '';
  const n = CLASSES.length;

  // Find max off-diagonal for color scaling
  let maxErr = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j && cm[i][j] > maxErr) maxErr = cm[i][j];

  const table = document.createElement('table');
  table.className = 'confusion-matrix';

  // Header row
  const thead = table.createTHead();
  const hRow = thead.insertRow();
  const cornerTh = document.createElement('th');
  cornerTh.className = 'row-header';
  cornerTh.textContent = 'Real \\ Predito';
  hRow.appendChild(cornerTh);
  CLASSES.forEach(cls => {
    const th = document.createElement('th');
    th.textContent = (CLASS_EMOJIS[cls] || '') + ' ' + cls.slice(0, 4) + '.';
    th.title = cls;
    hRow.appendChild(th);
  });

  // Data rows
  const tbody = document.createElement('tbody');
  for (let i = 0; i < n; i++) {
    const tr = tbody.insertRow();
    // Row label
    const labelTh = document.createElement('th');
    labelTh.className = 'row-header';
    labelTh.textContent = (CLASS_EMOJIS[CLASSES[i]] || '') + ' ' + CLASSES[i];
    tr.appendChild(labelTh);

    for (let j = 0; j < n; j++) {
      const td = tr.insertCell();
      td.textContent = cm[i][j];
      td.title = `Real: ${CLASSES[i]} | Predito: ${CLASSES[j]} | Contagem: ${cm[i][j]}`;
      if (i === j) {
        td.className = cm[i][j] > 0 ? 'cm-diagonal' : 'cm-zero';
      } else if (cm[i][j] === 0) {
        td.className = 'cm-zero';
      } else if (maxErr > 0 && cm[i][j] / maxErr > 0.5) {
        td.className = 'cm-error-hi';
      } else {
        td.className = 'cm-error-lo';
      }
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}

// ── Export report as JSON ──────────────────────────────────────
function exportReport() {
  if (!lastEvalReport) return;
  const { report, confusionMatrix, total, timestamp } = lastEvalReport;

  const data = {
    timestamp,
    totalImages: total,
    splitDescription: 'Conjunto de teste representando aprox. 20% dos dados (Principio de Pareto 80/20)',
    modelClasses: CLASSES,
    globalMetrics: {
      accuracy: parseFloat((report.accuracy * 100).toFixed(2)),
      macroPrecision: parseFloat((report.macroPrecision * 100).toFixed(2)),
      macroRecall: parseFloat((report.macroRecall * 100).toFixed(2)),
      macroF1: parseFloat((report.macroF1 * 100).toFixed(2)),
    },
    perClassMetrics: report.perClass.map(c => ({
      class: c.cls,
      support: c.support,
      precision: c.precision !== null ? parseFloat((c.precision * 100).toFixed(2)) : null,
      recall: c.recall !== null ? parseFloat((c.recall * 100).toFixed(2)) : null,
      f1: c.f1 !== null ? parseFloat((c.f1 * 100).toFixed(2)) : null,
    })),
    confusionMatrix: {
      labels: CLASSES,
      matrix: confusionMatrix,
    },
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `avaliacao_modelo_${timestamp.replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// =============================================================
//   DETECCAO COM SSD MobileNet (COCO-SSD)
// =============================================================

// Lazy-loaded detector (loaded only when tab is first opened)
let cocoModel = null;
let detStream = null;
let detLoopId = null;
let detCurrentMode = 'image'; // 'image' | 'webcam'

// Palette of distinct colors for COCO classes (cycles)
const DET_COLORS = [
  '#6c63ff', '#a855f7', '#06b6d4', '#22c55e',
  '#f59e0b', '#ef4444', '#ec4899', '#14b8a6',
  '#f97316', '#8b5cf6', '#0ea5e9', '#84cc16',
];
// Map COCO class names -> Portuguese
const COCO_PT = {
  dog: 'Cachorro', horse: 'Cavalo', elephant: 'Elefante',
  cat: 'Gato', cow: 'Vaca', sheep: 'Ovelha',
  bird: 'Ave', bear: 'Urso', zebra: 'Zebra',
  giraffe: 'Girafa', person: 'Pessoa', car: 'Carro',
  bicycle: 'Bicicleta', motorcycle: 'Moto', airplane: 'Aviao',
  bus: 'Onibus', truck: 'Caminhao', boat: 'Barco',
  chair: 'Cadeira', couch: 'Sofa', bed: 'Cama',
  'dining table': 'Mesa', toilet: 'Vaso Sanitario',
  tv: 'TV', laptop: 'Notebook', mouse: 'Mouse',
  keyboard: 'Teclado', 'cell phone': 'Celular',
  bottle: 'Garrafa', cup: 'Xicara', fork: 'Garfo',
  knife: 'Faca', spoon: 'Colher', bowl: 'Tigela',
  banana: 'Banana', apple: 'Maca', sandwich: 'Sanduiche',
  orange: 'Laranja', pizza: 'Pizza', cake: 'Bolo',
  book: 'Livro', clock: 'Relogio', scissors: 'Tesoura',
  umbrella: 'Guarda-chuva', backpack: 'Mochila',
  handbag: 'Bolsa', suitcase: 'Mala',
  'fire hydrant': 'Hidrante', 'stop sign': 'Placa PARE',
  bench: 'Banco', potted_plant: 'Planta',
  'potted plant': 'Planta', 'sports ball': 'Bola',
  kite: 'Pipa', skateboard: 'Skate', surfboard: 'Prancha',
  'tennis racket': 'Raquete',
};
const ANIMAL_CLASSES_EN = new Set(['dog','horse','elephant','cat','cow','sheep','bird','bear','zebra','giraffe']);

// Assign a stable color index per class name
const colorIndexCache = {};
function colorForClass(cls) {
  if (colorIndexCache[cls] === undefined) {
    colorIndexCache[cls] = Object.keys(colorIndexCache).length % DET_COLORS.length;
  }
  return DET_COLORS[colorIndexCache[cls]];
}

// ── Lazy load COCO-SSD ─────────────────────────────────────────
async function ensureCocoModel() {
  if (cocoModel) return true;
  const loadDiv = document.getElementById('det-loading');
  loadDiv.classList.remove('hidden');
  document.getElementById('det-loading-text').textContent = 'Carregando SSD MobileNet...';
  try {
    cocoModel = await cocoSsd.load({ base: 'mobilenet_v2' });
    console.log('[COCO-SSD] Modelo carregado.');
    loadDiv.classList.add('hidden');
    return true;
  } catch (err) {
    console.error('[COCO-SSD]', err);
    loadDiv.classList.add('hidden');
    showError('Falha ao carregar SSD MobileNet. Verifique sua conexao.');
    return false;
  }
}

// ── Mode switcher (Image / Webcam) ─────────────────────────────
function detSwitchMode(mode) {
  detCurrentMode = mode;
  document.getElementById('det-btn-image').classList.toggle('active', mode === 'image');
  document.getElementById('det-btn-webcam').classList.toggle('active', mode === 'webcam');
  document.getElementById('det-image-mode').classList.toggle('hidden', mode !== 'image');
  document.getElementById('det-webcam-mode').classList.toggle('hidden', mode !== 'webcam');
  document.getElementById('det-results').classList.add('hidden');
  if (mode !== 'webcam') stopDetWebcam();
}

// ── Image mode ─────────────────────────────────────────────────
function handleDetDrop(e) {
  e.preventDefault();
  document.getElementById('det-drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadDetImage(file);
}
function handleDetFileSelect(e) {
  const file = e.target.files[0];
  if (file) loadDetImage(file);
}
function loadDetImage(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    const img = document.getElementById('det-preview-img');
    img.src = ev.target.result;
    img.onload = () => {
      // Show canvas wrap, hide drop content
      document.getElementById('det-drop-content').classList.add('hidden');
      document.getElementById('det-canvas-wrap').classList.remove('hidden');
      document.getElementById('btn-detect-image').classList.remove('hidden');
      document.getElementById('btn-det-clear').classList.remove('hidden');
      document.getElementById('det-results').classList.add('hidden');
      // Clear canvas
      const canvas = document.getElementById('det-canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    };
  };
  reader.readAsDataURL(file);
}

async function runDetectImage() {
  const imgEl = document.getElementById('det-preview-img');
  if (!imgEl.src || !imgEl.naturalWidth) return;
  const btn = document.getElementById('btn-detect-image');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Detectando...';
  const ok = await ensureCocoModel();
  if (!ok) { btn.disabled = false; btn.innerHTML = '<span class="btn-icon">🔍</span> Detectar Objetos'; return; }
  try {
    // ── Compute object-fit:contain layout from the wrap container dimensions.
    // Both the <img> (CSS object-fit:contain) and our <canvas> overlay fill the
    // same ancestor (det-canvas-wrap), so using wrap.clientWidth/Height gives
    // the exact container the browser uses for the contain calculation.
    const wrap    = document.getElementById('det-canvas-wrap');
    const cW      = wrap.clientWidth  || 640;
    const cH      = wrap.clientHeight || 300;
    const nW      = imgEl.naturalWidth;
    const nH      = imgEl.naturalHeight;
    const scale   = Math.min(cW / nW, cH / nH);
    const rW      = nW * scale;
    const rH      = nH * scale;
    const offsetX = (cW - rW) / 2;
    const offsetY = (cH - rH) / 2;

    // ── Size canvas to the container (1 canvas px = 1 CSS px, no stretching)
    const canvas  = document.getElementById('det-canvas');
    canvas.width  = cW;
    canvas.height = cH;
    // Clear any previous boxes (canvas stays transparent — image shows through)
    canvas.getContext('2d').clearRect(0, 0, cW, cH);

    // ── Detect on the original img element (natural-coordinate bboxes)
    const predictions = await cocoModel.detect(imgEl);

    // ── Draw boxes on the transparent canvas overlay.
    // The <img> below it remains visible; boxes are drawn on top.
    drawBoundingBoxes(canvas, predictions, offsetX, offsetY, scale);
    renderDetResults(predictions);
  } catch (err) {
    console.error('[COCO-SSD detect]', err);
    showError('Erro ao detectar objetos na imagem.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🔍</span> Detectar Objetos';
  }
}

function clearDetection() {
  const img = document.getElementById('det-preview-img');
  img.src = '';
  document.getElementById('det-drop-content').classList.remove('hidden');
  document.getElementById('det-canvas-wrap').classList.add('hidden');
  document.getElementById('btn-detect-image').classList.add('hidden');
  document.getElementById('btn-det-clear').classList.add('hidden');
  document.getElementById('det-results').classList.add('hidden');
  document.getElementById('det-file-input').value = '';
  const canvas = document.getElementById('det-canvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// ── Webcam mode ────────────────────────────────────────────────
async function startDetWebcam() {
  const ok = await ensureCocoModel();
  if (!ok) return;
  try {
    detStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
    const video = document.getElementById('det-video');
    video.srcObject = detStream;
    document.getElementById('det-webcam-placeholder').classList.add('hidden');
    document.getElementById('btn-det-webcam-start').classList.add('hidden');
    document.getElementById('btn-det-webcam-stop').classList.remove('hidden');
    document.getElementById('det-live-indicator').classList.remove('hidden');
    detWindowStart = 0;
    detWindowBest = null;
    lastDetGroqClass = null;
    video.addEventListener('loadeddata', startDetLoop);
  } catch (err) {
    if (err.name === 'NotAllowedError') showError('Permissao de camera negada.');
    else showError('Nao foi possivel acessar a camera.');
  }
}

function stopDetWebcam() {
  stopDetLoop();
  detWindowStart = 0;
  detWindowBest = null;
  lastDetGroqClass = null;
  if (detStream) { detStream.getTracks().forEach(t => t.stop()); detStream = null; }
  const video = document.getElementById('det-video');
  if (video) { video.srcObject = null; }
  const ph = document.getElementById('det-webcam-placeholder');
  if (ph) ph.classList.remove('hidden');
  const btnStart = document.getElementById('btn-det-webcam-start');
  if (btnStart) btnStart.classList.remove('hidden');
  const btnStop = document.getElementById('btn-det-webcam-stop');
  if (btnStop) btnStop.classList.add('hidden');
  const ind = document.getElementById('det-live-indicator');
  if (ind) ind.classList.add('hidden');
  const canvas = document.getElementById('det-video-canvas');
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

function startDetLoop() {
  if (detLoopId) return;
  detLoopId = requestAnimationFrame(detectionLoop);
}
function stopDetLoop() {
  if (detLoopId) { cancelAnimationFrame(detLoopId); detLoopId = null; }
}

let lastDetTime = 0;
async function detectionLoop(timestamp) {
  if (!cocoModel || !detStream) { detLoopId = null; return; }
  if (timestamp - lastDetTime > 100) {
    lastDetTime = timestamp;
    const video = document.getElementById('det-video');
    if (video && video.readyState === 4 && video.videoWidth > 0) {
      // ── Measure from the wrap (parent), not from video.clientWidth,
      // to get the true displayed container size regardless of CSS model.
      const wrap = document.getElementById('det-webcam-wrap');
      const cW   = wrap.clientWidth  || video.clientWidth;
      const cH   = wrap.clientHeight || video.clientHeight;
      const nW   = video.videoWidth;
      const nH   = video.videoHeight;

      // object-fit: cover scale + center offset
      const scale   = Math.max(cW / nW, cH / nH);
      const offsetX = (cW - nW * scale) / 2;
      const offsetY = (cH - nH * scale) / 2;

      const canvas = document.getElementById('det-video-canvas');
      canvas.width  = cW;
      canvas.height = cH;
      try {
        const predictions = await cocoModel.detect(video);
        drawBoundingBoxes(canvas, predictions, offsetX, offsetY, scale);
        renderDetResults(predictions);
        accumulateDetGroq(predictions, video, timestamp);
      } catch (e) { /* ignore frame errors */ }
    }
  }
  detLoopId = requestAnimationFrame(detectionLoop);
}

// ── Disparo automatico da Groq na Deteccao ────────────────────
// A cada janela de 1s, escolhe o objeto de "categoria unica" (que aparece
// uma unica vez no frame) com a MAIOR confianca, recorta seu bounding box e
// envia ao Histórico IA. Aplica-se apenas ao modo webcam ao vivo.
function accumulateDetGroq(predictions, video, timestamp) {
  if (!detWindowStart) detWindowStart = timestamp;

  // "primeiro objeto de categoria unica": classe que ocorre 1x no frame
  const counts = {};
  predictions.forEach(p => { counts[p.class] = (counts[p.class] || 0) + 1; });
  const cand = predictions.find(p => counts[p.class] === 1 && p.score >= 0.30);

  // Guarda o melhor candidato da janela (recorta no pico, pois o frame muda)
  if (cand && (!detWindowBest || cand.score > detWindowBest.score)) {
    detWindowBest = { score: cand.score, class: cand.class, crop: cropFromVideo(video, cand.bbox) };
  }

  // Fecha a janela: envia o melhor recorte SE a categoria mudou. Sem a
  // comparacao com lastDetGroqClass, uma cena estavel dispararia ~1 req/s.
  if (timestamp - detWindowStart >= DET_WINDOW_MS) {
    if (detWindowBest && !detGroqBusy && detWindowBest.class !== lastDetGroqClass) {
      detGroqBusy = true;
      lastDetGroqClass = detWindowBest.class; // marca como enviada (nao reverte em erro)
      const best = detWindowBest;
      sendToFeed({
        source: 'detect',
        thumb: best.crop,
        localLabel: COCO_PT[best.class] || best.class,
        confidence: best.score,
      }).finally(() => { detGroqBusy = false; });
    }
    detWindowStart = timestamp;
    detWindowBest = null;
  }
}

// Recorta o bounding box (coordenadas naturais do video) como JPEG data URL.
function cropFromVideo(video, bbox) {
  let [x, y, w, h] = bbox;
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(video.videoWidth - x, w);
  h = Math.min(video.videoHeight - y, h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  c.getContext('2d').drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

// (getContainRect and getCoverRect removed — layout computed inline for precision)

// ── Canvas drawing — bounding boxes ────────────────────────────
// offsetX/Y and scale come from getContainRect or getCoverRect
function drawBoundingBoxes(canvas, predictions, offsetX, offsetY, scale) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  predictions.forEach(pred => {
    const [x, y, w, h] = pred.bbox;
    // Map source coordinates → display coordinates
    const sx = offsetX + x * scale;
    const sy = offsetY + y * scale;
    const sw = w * scale;
    const sh = h * scale;
    const color = colorForClass(pred.class);
    const conf  = (pred.score * 100).toFixed(1);
    const label = (COCO_PT[pred.class] || pred.class) + ' ' + conf + '%';

    // Box shadow/glow
    ctx.shadowColor = color;
    ctx.shadowBlur  = 10;

    // Rectangle
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.strokeRect(sx, sy, sw, sh);

    ctx.shadowBlur = 0;

    // Label background
    ctx.font = 'bold 13px Inter, sans-serif';
    const textW = ctx.measureText(label).width;
    const labelH = 20;
    const labelY = sy > labelH ? sy - labelH : sy + sh;

    ctx.fillStyle = color;
    ctx.fillRect(sx - 1, labelY, textW + 10, labelH);

    // Label text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, sx + 4, labelY + 14);

    // Corner dots
    ctx.fillStyle = color;
    [[sx, sy],[sx+sw, sy],[sx, sy+sh],[sx+sw, sy+sh]].forEach(([cx,cy]) => {
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  });
}

// ── Detection results list ──────────────────────────────────────
function renderDetResults(predictions) {
  const section  = document.getElementById('det-results');
  const list     = document.getElementById('det-results-list');
  const badge    = document.getElementById('det-count-badge');
  const noResult = document.getElementById('det-no-results');

  section.classList.remove('hidden');
  list.innerHTML = '';

  // Filter out very low confidence (< 30%)
  const filtered = predictions.filter(p => p.score >= 0.30);
  badge.textContent = filtered.length;

  if (filtered.length === 0) {
    noResult.classList.remove('hidden');
    return;
  }
  noResult.classList.add('hidden');

  filtered.forEach((pred, idx) => {
    const color    = colorForClass(pred.class);
    const conf     = pred.score;
    const confPct  = (conf * 100).toFixed(1);
    const namePT   = COCO_PT[pred.class] || pred.class;
    const isAnimal = ANIMAL_CLASSES_EN.has(pred.class);
    const confCls  = conf >= 0.75 ? 'high' : conf >= 0.50 ? 'medium' : 'low';

    const card = document.createElement('div');
    card.className = 'det-obj-card';
    card.style.animationDelay = `${idx * 50}ms`;
    card.innerHTML = `
      <div class="det-obj-color" style="background:${color};box-shadow:0 0 6px ${color}80"></div>
      <span class="det-obj-name">${isAnimal ? (CLASS_EMOJIS[namePT] || '🐾') + ' ' : ''}${namePT}</span>
      <div class="det-obj-bar-wrap">
        <div class="det-obj-bar-fill" style="width:${confPct}%;background:${color}"></div>
      </div>
      <span class="det-obj-conf ${confCls}">${confPct}%</span>`;
    list.appendChild(card);
  });
}
