// Five experiences on one shared, honest analysis engine:
// report (coach assessment), game (swing score), tutorial (swing school),
// compare (side-by-side), progress (local history).
import { getLandmarker, loadVideoFile, scanVideo, seek, drawSkeleton } from './engine.js';
import { analyzeSwing, scoreSwing, alignTimelines } from './metrics.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['homeView', 'uploadView', 'progressView', 'errorView',
  'reportView', 'gameView', 'tutorialView', 'compareView', 'progressTrackView'];

const state = {
  mode: null,
  swingA: null,        // { frames, analysis, score }
  swingB: null,        // second swing (compare mode)
  compareStage: 0,
};

/* ---------- view plumbing ---------- */

function show(id) {
  for (const v of VIEWS) $(v).classList.toggle('hidden', v !== id);
  window.scrollTo(0, 0);
}

function progress(label, frac, detail = '') {
  $('progressLabel').textContent = label;
  $('progressFill').style.width = `${Math.round(frac * 100)}%`;
  $('progressDetail').textContent = detail;
}

function fail(msg) { $('errorMsg').textContent = msg; show('errorView'); }

function goHome() { state.mode = null; state.compareStage = 0; show('homeView'); }

function uploadScreen(title, blurb) {
  $('uploadTitle').textContent = title;
  $('uploadBlurb').textContent = blurb;
  $('fileInput').value = '';
  show('uploadView');
}

const CONF_LABEL = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence', none: 'not measured' };
const dot = (c) => `<span class="confdot conf-${c}"></span>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/* ---------- local history (progress mode) ---------- */

const HISTORY_KEY = 'swingHistory';
const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } };
function saveHistoryEntry(swing) {
  const h = loadHistory();
  h.push({
    ts: Date.now(),
    score: swing.score?.score ?? null,
    grade: swing.score?.grade ?? null,
    quality: swing.analysis.quality.score,
    view: swing.analysis.view,
    metrics: swing.analysis.metrics.map((m) => ({ id: m.id, label: m.label, display: m.display, band: m.band, confidence: m.confidence })),
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-50)));
}
const personalBest = () => loadHistory().reduce((best, e) => (e.score !== null && e.score > best ? e.score : best), -1);

/* ---------- analyze flow (shared by report / game / tutorial / compare) ---------- */

async function analyzeFile(file, videoEl) {
  show('progressView');
  await getLandmarker(progress);
  await loadVideoFile(videoEl, file);
  const frames = await scanVideo(videoEl, progress);
  if (!frames || frames.length < 8) throw new Error('noperson');
  const analysis = analyzeSwing(frames);
  if (!analysis.ok) throw new Error('noswing');
  return { frames, analysis, score: scoreSwing(analysis) };
}

async function handleFile(file) {
  try {
    if (state.mode === 'compare' && state.compareStage === 2) {
      state.swingB = await analyzeFile(file, $('videoB'));
      saveHistoryEntry(state.swingB);
      renderCompare();
    } else {
      const prevBest = personalBest();
      state.swingA = await analyzeFile(file, $('videoA'));
      saveHistoryEntry(state.swingA);
      if (state.mode === 'compare') {
        state.compareStage = 2;
        uploadScreen('Now the second swing', 'Upload the swing to compare against — a different day, a different player, or a different cue.');
        return;
      }
      renderMode(state.mode, { prevBest });
    }
  } catch (e) {
    const v = state.mode === 'compare' && state.compareStage === 2 ? $('videoB') : $('videoA');
    const diag = v.videoWidth ? ` (video: ${Math.round(v.duration)}s · ${v.videoWidth}×${v.videoHeight})` : '';
    fail(e.message === 'decode' ? 'This video format couldn’t be played in the browser. Try recording with the regular camera app.'
      : e.message === 'noperson' ? 'We couldn’t find a person clearly enough in this video. Make sure the whole body is visible and well lit, then try again.'
      : e.message === 'noswing' ? 'We found a person but couldn’t identify a swing in this clip. Try a video with one clear swing in it.'
      : e.message === 'seek_stuck' || e.message === 'seek timeout'
        ? `Your phone’s browser stopped serving video frames partway through — this can happen with long or 4K clips${diag}. Try trimming the clip to just the swing (5–10s) in your Photos app, then upload again.`
      : `Something went wrong during analysis (${e.message})${diag}. Reload and try again.`);
  }
}

/* ---------- shared result widgets ---------- */

function videoBlock(videoEl, frames) {
  const wrap = document.createElement('div');
  wrap.className = 'videoWrap';
  const canvas = document.createElement('canvas');
  wrap.append(videoEl, canvas);
  videoEl.classList.remove('offstage');
  const showFrame = async (idx) => {
    idx = Math.max(0, Math.min(frames.length - 1, idx));
    try { await seek(videoEl, frames[idx].t); } catch { /* keep last decoded frame */ }
    drawSkeleton(canvas, videoEl, frames[idx]);
    return idx;
  };
  return { wrap, showFrame };
}

function navButtons(extraLabel, extraFn) {
  const div = document.createElement('div');
  div.className = 'buttons';
  const back = document.createElement('button');
  back.className = 'btn'; back.textContent = '← All modes'; back.onclick = goHome;
  div.append(back);
  if (extraLabel) {
    const b = document.createElement('button');
    b.className = 'btn primary'; b.textContent = extraLabel; b.onclick = extraFn;
    div.append(b);
  }
  return div;
}

const newSwingBtn = (mode) => navButtons('🎥 New swing', () => startMode(mode, { forceUpload: true }));

/* ---------- mode: coach report ---------- */

function renderReport() {
  const view = $('reportView');
  const { frames, analysis: a } = state.swingA;
  view.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<h2>Your swing</h2>';
  const { wrap, showFrame } = videoBlock($('videoA'), frames);
  card.append(wrap);

  const scrub = document.createElement('input');
  scrub.type = 'range'; scrub.min = 0; scrub.max = frames.length - 1; scrub.step = 1;
  scrub.oninput = () => { showFrame(Number(scrub.value)); setActiveChip(Number(scrub.value)); };
  card.append(scrub);

  const chips = document.createElement('div');
  chips.className = 'chips';
  const momentLabels = [['stance', 'Stance'], ['strideStart', 'Stride'], ['footPlant', 'Foot plant'], ['contact', 'Contact ⚡'], ['finish', 'Finish']];
  for (const [key, label] of momentLabels) {
    const idx = a.keyMoments[key];
    if (idx === null || idx === undefined) continue;
    const chip = document.createElement('button');
    chip.className = 'chip'; chip.textContent = label; chip.dataset.idx = idx;
    chip.onclick = () => { showFrame(idx); scrub.value = idx; setActiveChip(idx); };
    chips.append(chip);
  }
  const setActiveChip = (idx) => { for (const c of chips.children) c.classList.toggle('active', Number(c.dataset.idx) === idx); };
  card.append(chips);
  view.append(card);

  const q = a.quality;
  const viewLabel = { side: 'side view 👍', angled: 'angled view', front: 'facing the camera' }[a.view];
  const qCard = document.createElement('div');
  qCard.className = 'card';
  qCard.innerHTML = `
    <h2>How much can you trust this?</h2>
    <div class="scoreRow"><div class="scoreRing">${q.score}</div>
    <div><p><b>Video quality score.</b> We measured ${q.swingFrames} frames during the swing (${viewLabel}).</p></div></div>
    ${q.tips.length ? `<p class="hint"><b>Get a better analysis:</b> ${esc(q.tips.join(' '))}</p>` : '<p class="hint">Great capture — this is about as good as a single phone camera gets.</p>'}`;
  view.append(qCard);

  const fbHtml = (item) => `
    <div class="fb"><div class="title">${esc(item.title)}</div>
    <div class="measured">${dot(item.confidence)}measured: ${esc(item.measured)} · ${CONF_LABEL[item.confidence]}</div>
    <div class="detail">${esc(item.detail)}</div></div>`;

  const sCard = document.createElement('div'); sCard.className = 'card';
  sCard.innerHTML = '<h2>✅ What you’re doing well</h2>' +
    (a.feedback.strengths.length ? a.feedback.strengths.map(fbHtml).join('') : '<p class="hint">Nothing stood out as a clear strength in this clip — see the quality tips above.</p>');
  const iCard = document.createElement('div'); iCard.className = 'card';
  iCard.innerHTML = '<h2>🔧 What to work on</h2>' +
    (a.feedback.improvements.length ? a.feedback.improvements.map(fbHtml).join('') : '<p class="hint">No clear issues found at this confidence level. Nice swing!</p>');
  const mCard = document.createElement('div'); mCard.className = 'card';
  mCard.innerHTML = '<h2>📐 All measurements</h2>' + a.metrics.map((m) => `
    <div class="metric"><span class="label">${dot(m.confidence)}${esc(m.label)}</span><span class="value">${esc(m.display)}</span></div>`).join('');
  const hCard = document.createElement('div'); hCard.className = 'card honesty';
  hCard.innerHTML = '<h2>🪞 What we could NOT measure</h2><ul>' +
    a.notMeasured.map((n) => `<li><b>${esc(n.label)}</b> — ${esc(n.reason)}</li>`).join('') + '</ul>';
  view.append(sCard, iCard, mCard, hCard, newSwingBtn('report'));

  show('reportView');
  showFrame(a.keyMoments.contact);
  scrub.value = a.keyMoments.contact;
  setActiveChip(a.keyMoments.contact);
}

/* ---------- mode: swing score (game) ---------- */

function renderGame({ prevBest = -1 } = {}) {
  const view = $('gameView');
  const { analysis, score } = state.swingA;
  view.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'card center';
  if (!score) {
    card.innerHTML = `<h2>🕹️ Swing Score</h2>
      <p>We couldn’t measure enough of this swing to score it fairly — and we won’t make a number up.</p>
      <p class="hint">Try again with the whole body visible, ideally slow-mo from the side.</p>`;
    view.append(card, newSwingBtn('game'));
    return show('gameView');
  }

  const isNewBest = prevBest >= 0 ? score.score > prevBest : false;
  card.innerHTML = `
    <h2>🕹️ Swing Score</h2>
    <div class="bigScore" id="bigScore">0</div>
    <div class="grade">${esc(score.grade)}</div>
    ${isNewBest ? '<div class="best">🏆 New personal best!</div>'
      : prevBest > 0 ? `<div class="best muted">Personal best: ${prevBest}</div>` : ''}
    <p class="hint">Scored on ${score.scoredCount} of ${score.totalCount} measurable parts of your swing — anything we couldn’t see honestly isn’t in the score.</p>`;
  view.append(card);

  const parts = document.createElement('div');
  parts.className = 'card';
  parts.innerHTML = '<h2>Score breakdown</h2>' + score.parts.map((p) => p.scored ? `
    <div class="partRow"><span>${esc(p.label)}</span><span class="partPts">${p.points}/${p.weight}</span></div>
    <div class="bar slim"><div class="fill" style="width:${Math.round(p.credit * 100)}%"></div></div>`
    : `<div class="partRow muted"><span>${esc(p.label)}</span><span>not measured</span></div>`).join('');
  view.append(parts, newSwingBtn('game'));

  show('gameView');
  // count-up animation
  const el = $('bigScore');
  const t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / 1200);
    el.textContent = Math.round(score.score * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- mode: swing school (tutorial) ---------- */

function tutorialPhases(a) {
  const m = Object.fromEntries(a.metrics.map((x) => [x.id, x]));
  const has = (id) => m[id] && m[id].confidence !== 'none' && m[id].band !== 'unknown';
  const phases = [];
  phases.push({
    key: 'stance', title: '1 · Stance — the launch pad',
    body: 'Everything starts from balance: feet about shoulder-width, knees flexed, weight on the balls of the feet, eyes level on the pitcher. A good stance looks like you could jump in any direction.',
    yours: has('posture') ? `In your swing: ${m.posture.display}.` : null,
  });
  if (a.keyMoments.strideStart !== null) phases.push({
    key: 'strideStart', title: '2 · Stride — building momentum',
    body: 'The stride is a controlled step toward the pitcher while the hands stay back. It creates momentum without giving away balance — think "step softly, like onto thin ice."',
    yours: has('stride') ? `In your swing: stride measured ${m.stride.display}.` : 'In your swing: we couldn’t isolate a clear stride in this clip.',
  });
  if (a.keyMoments.footPlant !== null) phases.push({
    key: 'footPlant', title: '3 · Foot plant — the anchor',
    body: 'The front foot lands slightly closed and firms up. This is the trigger: the moment the foot anchors, the hips are free to fire. Watch how the front leg becomes a post to rotate against.',
    yours: null,
  });
  phases.push({
    key: 'contact', title: '4 · Contact — the moment of truth',
    body: 'Hips open, front leg firm, head still and down on the ball. All the energy built by the stride and hip turn arrives at the bat right here — in about 1/7th of a second.',
    yours: [has('frontKnee') ? `front leg: ${m.frontKnee.display}` : null,
            has('headDrift') ? `head movement: ${m.headDrift.display}` : null]
      .filter(Boolean).map((s) => `In your swing: ${s}.`).join(' ') || null,
  });
  phases.push({
    key: 'finish', title: '5 · Finish — balance tells the story',
    body: 'A balanced finish means the swing was under control the whole way. If you can hold your finish for two seconds, the energy went into the ball — not into keeping you upright.',
    yours: null,
  });
  return phases;
}

function renderTutorial() {
  const view = $('tutorialView');
  const { frames, analysis: a } = state.swingA;
  view.innerHTML = '';
  const phases = tutorialPhases(a);
  let step = 0;

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<h2>🎓 Swing School</h2><p class="hint">A tour through your own swing, phase by phase.</p>';
  const { wrap, showFrame } = videoBlock($('videoA'), frames);
  card.append(wrap);

  const dots = document.createElement('div'); dots.className = 'dots';
  const title = document.createElement('h3');
  const body = document.createElement('p');
  const yours = document.createElement('p'); yours.className = 'yours';
  const nav = document.createElement('div'); nav.className = 'buttons';
  const prev = document.createElement('button'); prev.className = 'btn'; prev.textContent = '← Back';
  const next = document.createElement('button'); next.className = 'btn primary';
  nav.append(prev, next);
  card.append(dots, title, body, yours, nav);
  view.append(card, newSwingBtn('tutorial'));

  const render = () => {
    const p = phases[step];
    title.textContent = p.title;
    body.textContent = p.body;
    yours.textContent = p.yours || '';
    yours.classList.toggle('hidden', !p.yours);
    prev.disabled = step === 0;
    next.textContent = step === phases.length - 1 ? 'Done ✓' : 'Next →';
    dots.innerHTML = phases.map((_, i) => `<span class="dotNav ${i === step ? 'on' : ''}"></span>`).join('');
    const idx = a.keyMoments[p.key];
    if (idx !== null && idx !== undefined) showFrame(idx);
  };
  prev.onclick = () => { if (step > 0) { step--; render(); } };
  next.onclick = () => { if (step < phases.length - 1) { step++; render(); } else goHome(); };

  show('tutorialView');
  render();
}

/* ---------- mode: side-by-side (compare) ---------- */

const BAND_RANK = { good: 2, fair: 1, short: 1, long: 1, check: 1, soft: 1, needs_work: 0 };

function renderCompare() {
  const view = $('compareView');
  const A = state.swingA, B = state.swingB;
  view.innerHTML = '';

  const lanes = alignTimelines(A.analysis, B.analysis, 60);
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<h2>⚖️ Side-by-Side</h2><p class="hint">Both swings synced so <b>contact lines up at the same point</b> on the slider.</p>';

  const blockA = videoBlock($('videoA'), A.frames);
  const blockB = videoBlock($('videoB'), B.frames);
  const labA = document.createElement('div'); labA.className = 'laneLabel'; labA.textContent = 'Swing 1';
  const labB = document.createElement('div'); labB.className = 'laneLabel'; labB.textContent = 'Swing 2';
  card.append(labA, blockA.wrap, labB, blockB.wrap);

  const scrub = document.createElement('input');
  scrub.type = 'range'; scrub.min = 0; scrub.max = 59; scrub.step = 1; scrub.value = lanes.contactStep;
  scrub.oninput = () => { blockA.showFrame(lanes.a[scrub.value]); blockB.showFrame(lanes.b[scrub.value]); };
  card.append(scrub);
  const contactBtn = document.createElement('button');
  contactBtn.className = 'chip'; contactBtn.textContent = 'Jump to contact ⚡';
  contactBtn.onclick = () => { scrub.value = lanes.contactStep; scrub.oninput(); };
  card.append(contactBtn);
  view.append(card);

  const table = document.createElement('div');
  table.className = 'card';
  table.innerHTML = '<h2>📐 Measurement deltas</h2>' + A.analysis.metrics.map((ma) => {
    const mb = B.analysis.metrics.find((x) => x.id === ma.id);
    const ra = BAND_RANK[ma.band], rb = BAND_RANK[mb?.band];
    const verdict = ra === undefined || rb === undefined ? ''
      : ra > rb ? ' <span class="deltaA">◀ swing 1 better</span>'
      : rb > ra ? ' <span class="deltaB">swing 2 better ▶</span>' : ' <span class="muted">even</span>';
    return `<div class="cmpRow"><div class="cmpLabel">${esc(ma.label)}${verdict}</div>
      <div class="cmpVals"><span>1: ${esc(ma.display)}</span><span>2: ${esc(mb ? mb.display : '—')}</span></div></div>`;
  }).join('') + '<p class="hint">“Better” compares measurement bands only where both swings were measured with confidence — everything else is shown without judgment.</p>';
  view.append(table, navButtons('🎥 New comparison', () => startMode('compare', { forceUpload: true })));

  show('compareView');
  blockA.showFrame(lanes.a[lanes.contactStep]);
  blockB.showFrame(lanes.b[lanes.contactStep]);
}

/* ---------- mode: progress ---------- */

function sparkline(values, w = 320, h = 56) {
  if (values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 6 - ((v - min) / span) * (h - 12)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" class="spark"><polyline points="${pts}" /></svg>`;
}

function renderProgress() {
  const view = $('progressTrackView');
  const h = loadHistory();
  view.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'card';
  if (h.length === 0) {
    card.innerHTML = `<h2>📈 Progress</h2>
      <p>No swings analyzed yet on this device. Every swing you run through any mode lands here automatically.</p>
      <p class="hint">Analyses are stored only on this device — nothing is uploaded anywhere.</p>`;
    view.append(card, navButtons('🎥 Analyze a swing', () => startMode('report', { forceUpload: true })));
    return show('progressTrackView');
  }

  const scores = h.filter((e) => e.score !== null).map((e) => e.score);
  card.innerHTML = `<h2>📈 Progress</h2>
    <p>${h.length} swing${h.length > 1 ? 's' : ''} analyzed on this device · best score: <b>${Math.max(0, ...scores) || '—'}</b></p>
    ${scores.length >= 2 ? sparkline(scores) + '<p class="hint">Swing score over time</p>' : '<p class="hint">Analyze one more swing to see your trend line.</p>'}`;
  view.append(card);

  const list = document.createElement('div');
  list.className = 'card';
  list.innerHTML = '<h2>History</h2>' + [...h].reverse().map((e) => `
    <div class="histRow">
      <span>${new Date(e.ts).toLocaleDateString()} ${new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <span>${e.score !== null ? `<b>${e.score}</b> (${esc(e.grade)})` : 'unscored'} · cam ${e.quality}</span>
    </div>`).join('');
  view.append(list);

  const clear = document.createElement('button');
  clear.className = 'btn danger';
  clear.textContent = 'Delete history from this device';
  clear.onclick = () => { if (confirm('Delete all saved swing analyses from this device?')) { localStorage.removeItem(HISTORY_KEY); renderProgress(); } };
  const btns = navButtons('🎥 Analyze a swing', () => startMode('report', { forceUpload: true }));
  btns.prepend(clear);
  view.append(btns);
  show('progressTrackView');
}

/* ---------- routing ---------- */

const UPLOAD_COPY = {
  report: ['Coach Report', 'Record or pick a video of one swing. Slow-motion from the side works best — and we’ll tell you how much we could trust the result.'],
  game: ['Swing Score', 'One swing, one score. Slow-mo side view scores most fairly — we only score what we can actually measure.'],
  tutorial: ['Swing School', 'Upload one swing and we’ll walk you through it phase by phase — your video becomes the lesson.'],
  compare: ['First swing', 'Upload the first of the two swings you want to compare.'],
};

function renderMode(mode, extra = {}) {
  if (mode === 'report') renderReport();
  else if (mode === 'game') renderGame(extra);
  else if (mode === 'tutorial') renderTutorial();
  else goHome();
}

function startMode(mode, { forceUpload = false } = {}) {
  state.mode = mode;
  if (mode === 'progress') return renderProgress();
  if (mode === 'compare') {
    state.compareStage = 1;
    state.swingB = null;
    return uploadScreen(...UPLOAD_COPY.compare);
  }
  if (!forceUpload && state.swingA) return renderMode(mode, { prevBest: personalBest() });
  uploadScreen(...UPLOAD_COPY[mode]);
}

for (const cardBtn of document.querySelectorAll('.modeCard')) {
  cardBtn.onclick = () => startMode(cardBtn.dataset.mode);
}
for (const b of document.querySelectorAll('[data-back]')) b.onclick = goHome;
$('fileInput').addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
});

// expose for headless verification
window.__poc = { state, startMode, get analysis() { return state.swingA?.analysis; }, get frames() { return state.swingA?.frames; } };
