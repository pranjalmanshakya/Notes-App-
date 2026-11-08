'use strict';
/* Notes — typed text, handwriting, screenshots, Google Drive sync. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ================= IndexedDB ================= */
let dbPromise;
function db() {
  return (dbPromise ||= new Promise((res, rej) => {
    const r = indexedDB.open('notes-db', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('shared')) d.createObjectStore('shared', { autoIncrement: true });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
function tx(store, mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  }));
}
const idb = {
  all: (st) => tx(st, 'readonly', (s) => s.getAll()),
  get: (st, k) => tx(st, 'readonly', (s) => s.get(k)),
  put: (st, v, k) => tx(st, 'readwrite', (s) => (k === undefined ? s.put(v) : s.put(v, k))),
  del: (st, k) => tx(st, 'readwrite', (s) => s.delete(k)),
  clear: (st) => tx(st, 'readwrite', (s) => s.clear()),
};

/* ================= State ================= */
const notes = new Map();
let current = null;
let mode = 'type';
const settings = { clientId: '', autoSync: true, folderId: null, signedIn: false, email: '' };
const prefs = { tool: 'pen', color: 'auto', size: 3 };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('ink-prefs') || '{}')); } catch {}

const saveSettings = () => idb.put('kv', { ...settings }, 'settings');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ================= Elements ================= */
const listView = $('#listView'), editorView = $('#editorView');
const grid = $('#grid'), empty = $('#empty'), search = $('#search');
const titleInput = $('#titleInput'), body = $('#body'), page = $('#page');
const scroller = $('#scroller'), wrap = $('#wrap'), cv = $('#ink'), ctx = cv.getContext('2d');
const textTools = $('#textTools'), inkTools = $('#inkTools');
const moreMenu = $('#moreMenu'), syncBtn = $('#syncBtn');

/* ================= Toast ================= */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ================= Note list ================= */
function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function renderList() {
  const q = search.value.trim().toLowerCase();
  const arr = [...notes.values()]
    .filter((n) => !n.deleted)
    .filter((n) => !q || ((n.title || '') + ' ' + (n.text || '')).toLowerCase().includes(q))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);

  grid.replaceChildren();
  empty.hidden = arr.length > 0 || !!q;
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--ink-auto').trim();

  for (const n of arr) {
    const card = document.createElement('article');
    card.className = 'card';
    card.onclick = () => openNote(n);

    const imgMatch = /<img[^>]+src="([^"]+)"/.exec(n.html || '');
    if (imgMatch) {
      const img = document.createElement('img');
      img.className = 'thumb'; img.src = imgMatch[1]; img.alt = ''; img.loading = 'lazy';
      card.append(img);
    } else if (n.ink && n.ink.length) {
      const c = document.createElement('canvas');
      card.append(c);
      requestAnimationFrame(() => {
        const dpr = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight;
        c.width = w * dpr; c.height = h * dpr;
        const cx = c.getContext('2d'); cx.scale(dpr, dpr);
        const minY = Math.min(...n.ink.map((s) => s.b[1]));
        const off = Math.max(0, minY * w - 10);
        for (const s of n.ink) drawStroke(cx, s, w, -off, fg);
      });
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const h = document.createElement('h3');
    h.textContent = (n.pinned ? '📌 ' : '') + (n.title || (n.text || '').split('\n')[0] || 'Untitled');
    meta.append(h);
    if (n.text && n.title) {
      const p = document.createElement('p'); p.textContent = n.text; meta.append(p);
    }
    const t = document.createElement('time'); t.textContent = fmtDate(n.updated); meta.append(t);
    card.append(meta);
    grid.append(card);
  }
}
search.addEventListener('input', renderList);

/* ================= Editor open / close / save ================= */
let editorPushed = false;

function newNote() {
  const now = Date.now();
  return { id: uid(), title: '', html: '', text: '', ink: [], created: now, updated: now, pinned: false };
}

function openNote(n) {
  current = n;
  titleInput.value = n.title || '';
  body.innerHTML = n.html || '';
  ink.strokes = n.ink || [];
  ink.undo = []; ink.redo = [];
  listView.hidden = true;
  editorView.hidden = false;
  moreMenu.hidden = true;
  setMode('type');
  history.pushState({ note: n.id }, '');
  editorPushed = true;
  requestAnimationFrame(() => { scroller.scrollTop = 0; sizeCanvas(); updatePageHeight(); updateUndoBtns(); });
}

function isEmptyNote(n) {
  return !n.title && !(n.text || '').trim() && !(n.ink && n.ink.length) && !/<img/i.test(n.html || '');
}

async function closeEditor() {
  if (!current) return;
  await saveNow();
  const n = current;
  current = null;
  editorPushed = false;
  if (isEmptyNote(n) && !n.driveId) {
    notes.delete(n.id);
    await idb.del('notes', n.id);
  }
  editorView.hidden = true;
  listView.hidden = false;
  renderList();
  queueSync();
}

let saveTimer = null, dirty = false;
function scheduleSave() {
  if (!current) return;
  current.updated = Date.now();
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!current || !dirty) return;
  dirty = false;
  current.title = titleInput.value.trim();
  current.html = body.innerHTML;
  current.text = (body.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 400);
  current.ink = ink.strokes;
  notes.set(current.id, current);
  await idb.put('notes', current);
  queueSync();
}

titleInput.addEventListener('input', scheduleSave);
titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); body.focus(); } });
body.addEventListener('input', () => { scheduleSave(); updatePageHeight(); });

$('#newBtn').onclick = () => { openNote(newNote()); setTimeout(() => body.focus(), 50); };
$('#backBtn').onclick = () => (editorPushed ? history.back() : closeEditor());
window.addEventListener('popstate', () => { if (current) closeEditor(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
  else queueSync(500);
});

/* ================= Text formatting ================= */
textTools.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
textTools.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cmd]');
  if (!b) return;
  body.focus();
  const cmd = b.dataset.cmd;
  if (cmd === 'heading') {
    const block = document.queryCommandValue('formatBlock').toLowerCase();
    document.execCommand('formatBlock', false, block === 'h2' ? 'div' : 'h2');
  } else if (cmd === 'checklist') {
    const ul = closestInBody('ul');
    if (ul && ul.classList.contains('checklist')) {
      document.execCommand('insertUnorderedList');
    } else {
      if (!ul) document.execCommand('insertUnorderedList');
      const u = closestInBody('ul');
      if (u) u.classList.add('checklist');
    }
  } else {
    document.execCommand(cmd);
  }
  scheduleSave();
});
function closestInBody(tag) {
  const s = getSelection();
  if (!s.rangeCount) return null;
  let n = s.anchorNode;
  if (n && n.nodeType === 3) n = n.parentNode;
  const el = n && n.closest ? n.closest(tag) : null;
  return el && body.contains(el) ? el : null;
}
// Tap the box of a checklist item to tick it.
body.addEventListener('click', (e) => {
  const li = e.target.closest('ul.checklist > li');
  if (!li) return;
  const x = e.clientX - li.getBoundingClientRect().left;
  if (x < 30) { li.classList.toggle('done'); scheduleSave(); }
});

/* ================= Images & screenshots ================= */
let savedRange = null;
document.addEventListener('selectionchange', () => {
  const s = getSelection();
  if (s.rangeCount && body.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
});

function insertAtCaret(frag) {
  let r = savedRange;
  if (!r || !body.contains(r.startContainer)) {
    r = document.createRange();
    r.selectNodeContents(body);
    r.collapse(false);
  }
  const last = frag.lastChild;
  r.deleteContents();
  r.insertNode(frag);
  if (last) {
    r = document.createRange();
    r.setStart(last, 0);
    r.collapse(true);
    savedRange = r;
  }
}

async function compressImage(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1280 / bmp.width, 3000 / bmp.height);
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  let url = c.toDataURL('image/webp', 0.86);
  if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', 0.86);
  return url;
}

async function insertImages(files) {
  files = [...files].filter((f) => f && f.type && f.type.startsWith('image/'));
  if (!files.length) return;
  if (mode === 'draw') setMode('type');
  for (const f of files) {
    try {
      const src = await compressImage(f);
      const frag = document.createDocumentFragment();
      const holder = document.createElement('div');
      const img = document.createElement('img');
      img.src = src; img.alt = '';
      holder.append(img);
      const after = document.createElement('div');
      after.append(document.createElement('br'));
      frag.append(holder, after);
      insertAtCaret(frag);
    } catch (err) {
      console.error(err);
      toast('Could not add that image');
    }
  }
  scheduleSave();
  updatePageHeight();
}

const fileInput = $('#fileInput');
$('#imgBtn').onclick = () => fileInput.click();
fileInput.onchange = () => { insertImages(fileInput.files); fileInput.value = ''; };

// Paste (long-press → Paste, or keyboard clipboard) — screenshots go straight in.
document.addEventListener('paste', (e) => {
  if (!current) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); insertImages(files); return; }
  // Keep pasted text plain so styles from other apps don't leak in.
  if (e.target === body || body.contains(e.target)) {
    const text = e.clipboardData?.getData('text/plain');
    if (text != null && !e.clipboardData.types.includes('text/html')) return;
    if (text) { e.preventDefault(); document.execCommand('insertText', false, text); }
  }
});

// Items shared from other apps (Android share sheet → Notes).
async function consumeShared() {
  const items = await idb.all('shared');
  if (!items || !items.length) return;
  await idb.clear('shared');
  openNote(newNote());
  for (const it of items) {
    if (it.text) {
      const d = document.createElement('div');
      d.textContent = it.text;
      const f = document.createDocumentFragment(); f.append(d);
      insertAtCaret(f);
    }
  }
  await insertImages(items.filter((i) => i.file).map((i) => i.file));
  scheduleSave();
  toast('Added to a new note');
}

/* ================= Handwriting ================= */
const ink = { strokes: [], undo: [], redo: [], cur: null };
const COLORS = ['auto', '#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#fdd835'];
let dpr = 1, rafPending = false;
const pageW = () => page.clientWidth || 1;

function sizeCanvas() {
  const r = wrap.getBoundingClientRect();
  dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  cv.style.width = r.width + 'px';
  cv.style.height = r.height + 'px';
  redraw();
}
new ResizeObserver(() => { if (current) { sizeCanvas(); updatePageHeight(); } }).observe(wrap);
scroller.addEventListener('scroll', requestRedraw, { passive: true });

function requestRedraw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; redraw(); });
}

const widthFactor = (pr) => 0.55 + pr * 0.9;

function drawStroke(c, s, scale, offY, fg, vMin, vMax) {
  if (vMin !== undefined && (s.b[3] + s.s < vMin || s.b[1] - s.s > vMax)) return;
  const p = s.p, n = p.length / 3;
  const X = (i) => p[i * 3] * scale, Y = (i) => p[i * 3 + 1] * scale + offY;
  c.save();
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = c.fillStyle = s.c === 'auto' ? fg : s.c;
  if (s.t === 'hl') {
    c.globalAlpha = 0.35;
    c.lineWidth = s.s * scale;
    c.beginPath();
    c.moveTo(X(0), Y(0));
    if (n === 1) c.lineTo(X(0) + 0.1, Y(0));
    for (let i = 1; i < n - 1; i++) c.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
    if (n > 1) c.lineTo(X(n - 1), Y(n - 1));
    c.stroke();
  } else {
    const base = s.s * scale;
    if (n === 1) {
      c.beginPath(); c.arc(X(0), Y(0), (base * widthFactor(p[2])) / 2, 0, Math.PI * 2); c.fill();
    } else {
      let px = X(0), py = Y(0);
      for (let i = 1; i < n; i++) {
        const last = i === n - 1;
        const mx = last ? X(i) : (X(i) + X(i + 1)) / 2;
        const my = last ? Y(i) : (Y(i) + Y(i + 1)) / 2;
        c.beginPath();
        c.lineWidth = base * widthFactor(p[i * 3 + 2]);
        c.moveTo(px, py);
        c.quadraticCurveTo(X(i), Y(i), mx, my);
        c.stroke();
        px = mx; py = my;
      }
    }
  }
  c.restore();
}

let eraserPos = null;
function redraw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!current) return;
  const w = pageW(), top = scroller.scrollTop, h = cv.height / dpr;
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--ink-auto').trim() || '#111';
  for (const s of ink.strokes) drawStroke(ctx, s, w, -top, fg, top / w, (top + h) / w);
  if (ink.cur) drawStroke(ctx, ink.cur, w, -top, fg);
  if (eraserPos) {
    ctx.beginPath();
    ctx.arc(eraserPos[0], eraserPos[1], 14, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(128,128,128,.8)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

function updatePageHeight() {
  if (!current) return;
  const w = pageW();
  let maxY = 0;
  for (const s of ink.strokes) if (s.b[3] > maxY) maxY = s.b[3];
  const extra = mode === 'draw' ? scroller.clientHeight * 0.7 : 60;
  page.style.minHeight = Math.max(scroller.clientHeight, maxY * w + extra) + 'px';
}

function setMode(m) {
  mode = m;
  editorView.dataset.mode = m;
  textTools.hidden = m !== 'type';
  inkTools.hidden = m !== 'draw';
  $('#modeBtn').classList.toggle('active', m === 'draw');
  body.contentEditable = m === 'type' ? 'true' : 'false';
  if (m === 'draw') {
    body.blur();
    const hint = $('#drawHint');
    hint.hidden = true; void hint.offsetWidth; hint.hidden = false;
  } else {
    $('#drawHint').hidden = true;
  }
  updatePageHeight();
  requestAnimationFrame(sizeCanvas);
}
$('#modeBtn').onclick = () => setMode(mode === 'draw' ? 'type' : 'draw');

// --- ink toolbar ---
const swatches = $('#swatches');
for (const c of COLORS) {
  const b = document.createElement('button');
  b.className = 'swatch' + (c === 'auto' ? ' auto' : '');
  if (c !== 'auto') b.style.background = c;
  b.dataset.color = c;
  b.setAttribute('aria-label', c === 'auto' ? 'Black / white' : c);
  swatches.append(b);
}
function syncInkUI() {
  $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === prefs.tool));
  $$('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === prefs.color));
  $('#sizeRange').value = prefs.size;
  try { localStorage.setItem('ink-prefs', JSON.stringify(prefs)); } catch {}
}
inkTools.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tool]');
  if (t) { prefs.tool = t.dataset.tool; syncInkUI(); }
  const s = e.target.closest('[data-color]');
  if (s) { prefs.color = s.dataset.color; if (prefs.tool === 'eraser') prefs.tool = 'pen'; syncInkUI(); }
});
$('#sizeRange').addEventListener('input', (e) => { prefs.size = +e.target.value; syncInkUI(); });
syncInkUI();

function pushUndo() {
  ink.undo.push(ink.strokes.slice());
  if (ink.undo.length > 80) ink.undo.shift();
  ink.redo = [];
}
function inkChanged() {
  current.ink = ink.strokes;
  updatePageHeight();
  scheduleSave();
  requestRedraw();
  updateUndoBtns();
}
function updateUndoBtns() {
  $('#undoBtn').disabled = !ink.undo.length;
  $('#redoBtn').disabled = !ink.redo.length;
}
$('#undoBtn').onclick = () => { if (!ink.undo.length) return; ink.redo.push(ink.strokes); ink.strokes = ink.undo.pop(); inkChanged(); };
$('#redoBtn').onclick = () => { if (!ink.redo.length) return; ink.undo.push(ink.strokes); ink.strokes = ink.redo.pop(); inkChanged(); };

// --- pointer handling: 1 finger / pen draws, 2 fingers scroll ---
const ptrs = new Map();
let panning = false, lastMidY = 0, erasing = false, eraseStart = null;

function toPt(e) {
  const r = wrap.getBoundingClientRect(), w = pageW();
  const x = (e.clientX - r.left + scroller.scrollLeft) / w;
  const y = (e.clientY - r.top + scroller.scrollTop) / w;
  const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
  return [+x.toFixed(4), +y.toFixed(4), +pr.toFixed(2)];
}
const midY = () => { let s = 0; for (const v of ptrs.values()) s += v[1]; return s / ptrs.size; };

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function eraseAt(pt) {
  const r = 14 / pageW();
  const [x, y] = pt;
  const before = ink.strokes.length;
  ink.strokes = ink.strokes.filter((s) => {
    const rr = r + s.s / 2;
    if (x < s.b[0] - rr || x > s.b[2] + rr || y < s.b[1] - rr || y > s.b[3] + rr) return true;
    const p = s.p, n = p.length / 3;
    if (n === 1) return Math.hypot(x - p[0], y - p[1]) > rr;
    for (let i = 1; i < n; i++) {
      if (segDist(x, y, p[i * 3 - 3], p[i * 3 - 2], p[i * 3], p[i * 3 + 1]) <= rr) return false;
    }
    return true;
  });
  return ink.strokes.length !== before;
}

cv.addEventListener('pointerdown', (e) => {
  if (mode !== 'draw') return;
  e.preventDefault();
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (ptrs.size >= 2) {
    ink.cur = null;            // second finger → cancel stroke, start scrolling
    if (erasing) finishErase();
    panning = true;
    lastMidY = midY();
    requestRedraw();
    return;
  }
  if (panning) return;
  const pt = toPt(e);
  if (prefs.tool === 'eraser') {
    erasing = true;
    eraseStart = ink.strokes.slice();
    eraseAt(pt);
    const r = wrap.getBoundingClientRect();
    eraserPos = [e.clientX - r.left, e.clientY - r.top];
  } else {
    const hl = prefs.tool === 'hl';
    const size = (hl ? prefs.size * 4 + 6 : prefs.size) / pageW();
    ink.cur = { t: hl ? 'hl' : 'pen', c: prefs.color === 'auto' && hl ? '#fdd835' : prefs.color, s: +size.toFixed(5), p: [...pt], b: [pt[0], pt[1], pt[0], pt[1]] };
  }
  requestRedraw();
});

cv.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (panning) {
    const m = midY();
    scroller.scrollTop -= m - lastMidY;
    lastMidY = m;
    return;
  }
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  if (ink.cur) {
    const s = ink.cur, p = s.p, w = pageW();
    for (const ev of events.length ? events : [e]) {
      const pt = toPt(ev);
      const lx = p[p.length - 3], ly = p[p.length - 2];
      if (Math.hypot(pt[0] - lx, pt[1] - ly) * w < 0.8) continue;
      p.push(...pt);
      s.b[0] = Math.min(s.b[0], pt[0]); s.b[1] = Math.min(s.b[1], pt[1]);
      s.b[2] = Math.max(s.b[2], pt[0]); s.b[3] = Math.max(s.b[3], pt[1]);
    }
    requestRedraw();
  } else if (erasing) {
    for (const ev of events.length ? events : [e]) eraseAt(toPt(ev));
    const r = wrap.getBoundingClientRect();
    eraserPos = [e.clientX - r.left, e.clientY - r.top];
    requestRedraw();
  }
});

function finishErase() {
  erasing = false;
  eraserPos = null;
  if (eraseStart && eraseStart.length !== ink.strokes.length) {
    ink.undo.push(eraseStart); ink.redo = [];
    inkChanged();
  }
  eraseStart = null;
}
function pointerEnd(e) {
  if (!ptrs.delete(e.pointerId)) return;
  if (ptrs.size > 0) return;
  if (ink.cur) {
    pushUndo();
    ink.strokes.push(ink.cur);
    ink.cur = null;
    inkChanged();
  }
  if (erasing) finishErase();
  panning = false;
  requestRedraw();
}
cv.addEventListener('pointerup', pointerEnd);
cv.addEventListener('pointercancel', pointerEnd);

/* ================= More menu ================= */
$('#moreBtn').onclick = (e) => {
  e.stopPropagation();
  moreMenu.querySelector('[data-act="pin"]').textContent = current?.pinned ? 'Unpin' : 'Pin to top';
  moreMenu.hidden = !moreMenu.hidden;
};
document.addEventListener('click', (e) => { if (!moreMenu.hidden && !moreMenu.contains(e.target)) moreMenu.hidden = true; });
moreMenu.addEventListener('click', async (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act || !current) return;
  moreMenu.hidden = true;
  if (act === 'pin') { current.pinned = !current.pinned; scheduleSave(); toast(current.pinned ? 'Pinned' : 'Unpinned'); }
  if (act === 'clearInk') {
    if (!ink.strokes.length) return;
    pushUndo(); ink.strokes = []; inkChanged(); toast('Handwriting cleared — undo in pen mode');
  }
  if (act === 'delete') {
    if (!confirm('Delete this note?')) return;
    const n = current;
    await saveNow();
    n.deleted = true; n.updated = Date.now();
    if (n.driveId) { notes.set(n.id, n); await idb.put('notes', n); }
    else { notes.delete(n.id); await idb.del('notes', n.id); }
    current = null;
    if (editorPushed) { editorPushed = false; history.back(); }
    editorView.hidden = true; listView.hidden = false;
    renderList();
    toast('Note deleted');
    queueSync();
  }
});

/* ================= Google Drive sync ================= */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Notes App';
class AuthNeeded extends Error {}
let token = null, tokenExp = 0;
try {
  const t = JSON.parse(localStorage.getItem('gtoken') || 'null');
  if (t && t.exp > Date.now()) { token = t.token; tokenExp = t.exp; }
} catch {}

let gisPromise = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return (gisPromise ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = res;
    s.onerror = () => { gisPromise = null; rej(new Error('Could not load Google sign-in. Are you online?')); };
    document.head.append(s);
  }));
}

const hasToken = () => token && Date.now() < tokenExp - 60000;

// Must be called directly from a tap so the Google popup isn't blocked.
async function signIn() {
  if (!settings.clientId) throw new Error('Paste your Google Client ID first');
  if (!window.google?.accounts?.oauth2) await loadGis();
  await new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: settings.clientId,
      scope: SCOPE,
      prompt: settings.signedIn ? '' : 'consent',
      login_hint: settings.email || undefined,
      callback: (r) => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        token = r.access_token;
        tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        try { localStorage.setItem('gtoken', JSON.stringify({ token, exp: tokenExp })); } catch {}
        res();
      },
      error_callback: (err) => rej(new Error(err?.type === 'popup_closed' ? 'Sign-in was closed' : (err?.message || 'Sign-in failed'))),
    });
    client.requestAccessToken();
  });
  settings.signedIn = true;
  try {
    const about = await (await gfetch('/drive/v3/about?fields=user(emailAddress,displayName)')).json();
    settings.email = about.user?.emailAddress || '';
  } catch {}
  await saveSettings();
  updateAccountUI();
}

function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  token = null; tokenExp = 0;
  try { localStorage.removeItem('gtoken'); } catch {}
  settings.signedIn = false; settings.email = ''; settings.folderId = null;
  saveSettings();
  updateAccountUI();
  setSyncState('off');
}

async function gfetch(path, opts = {}) {
  if (!hasToken()) throw new AuthNeeded('Sign in again');
  const url = path.startsWith('http') ? path : 'https://www.googleapis.com' + path;
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  if (r.status === 401) { token = null; throw new AuthNeeded('Sign in again'); }
  if (!r.ok) {
    const err = new Error('Google Drive error ' + r.status + ': ' + (await r.text()).slice(0, 160));
    err.status = r.status;
    throw err;
  }
  return r;
}

async function ensureFolder() {
  if (settings.folderId) {
    try {
      const f = await (await gfetch(`/drive/v3/files/${settings.folderId}?fields=id,trashed`)).json();
      if (!f.trashed) return f.id;
    } catch (e) { if (e instanceof AuthNeeded) throw e; }
  }
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await (await gfetch(`/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`)).json();
  let id = found.files?.[0]?.id;
  if (!id) {
    const r = await gfetch('/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    id = (await r.json()).id;
  }
  settings.folderId = id;
  await saveSettings();
  return id;
}

async function listRemote(folder) {
  const out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
    const j = await (await gfetch(`/drive/v3/files?q=${q}&pageSize=1000&fields=nextPageToken,files(id,appProperties)${pageToken ? '&pageToken=' + pageToken : ''}`)).json();
    out.push(...(j.files || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

async function uploadNote(n, folder) {
  const payload = { id: n.id, title: n.title, html: n.html, text: n.text, ink: n.ink, created: n.created, updated: n.updated, pinned: !!n.pinned };
  const safeTitle = (n.title || n.text || 'Untitled').split('\n')[0].replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || 'Untitled';
  const meta = { name: safeTitle + '.json', mimeType: 'application/json', appProperties: { noteId: n.id, updated: String(n.updated) } };
  const send = (fileId) => {
    const m = fileId ? meta : { ...meta, parents: [folder] };
    const boundary = 'notes' + Math.random().toString(36).slice(2);
    const bodyStr = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(m)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--`;
    const url = 'https://www.googleapis.com/upload/drive/v3/files' + (fileId ? '/' + fileId : '') + '?uploadType=multipart&fields=id';
    return gfetch(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: bodyStr });
  };
  let r;
  try { r = await send(n.driveId); }
  catch (e) { if (e.status === 404 && n.driveId) r = await send(null); else throw e; }
  n.driveId = (await r.json()).id;
  n.syncedAt = n.updated;
  notes.set(n.id, n);
  await idb.put('notes', n);
}

async function downloadNote(f, local) {
  const data = await (await gfetch(`/drive/v3/files/${f.id}?alt=media`)).json();
  const n = { ...(local || {}), ...data, deleted: false, driveId: f.id, syncedAt: data.updated };
  notes.set(n.id, n);
  await idb.put('notes', n);
  if (current && current.id === n.id && !dirty) {
    current = n;
    titleInput.value = n.title || '';
    body.innerHTML = n.html || '';
    ink.strokes = n.ink || [];
    updatePageHeight(); requestRedraw();
  }
}

let syncing = false, syncAgain = false, syncTimer = null;
function setSyncState(s) { syncBtn.dataset.state = s; }

async function sync() {
  if (syncing) { syncAgain = true; return; }
  if (!settings.clientId || !settings.signedIn) { setSyncState('off'); return; }
  if (!hasToken()) { setSyncState('signin'); return; }
  if (!navigator.onLine) { setSyncState('error'); return; }
  syncing = true;
  setSyncState('syncing');
  try {
    await saveNow();
    const folder = await ensureFolder();
    const remote = await listRemote(folder);
    const byNote = new Map();
    for (const f of remote) if (f.appProperties?.noteId) byNote.set(f.appProperties.noteId, f);

    let changedList = false;
    // Remote → local
    for (const [nid, f] of byNote) {
      const rUpd = Number(f.appProperties.updated) || 0;
      const local = notes.get(nid);
      if (!local) { await downloadNote(f); changedList = true; continue; }
      if (local.deleted) continue;
      if (!local.driveId) local.driveId = f.id;
      const synced = local.syncedAt || 0;
      const remoteChanged = rUpd > synced, localChanged = local.updated > synced;
      if (remoteChanged && (!localChanged || rUpd >= local.updated)) { await downloadNote(f, local); changedList = true; }
      else if (localChanged) await uploadNote(local, folder);
    }
    // Local → remote
    for (const n of [...notes.values()]) {
      const f = byNote.get(n.id);
      if (n.deleted) {
        if (n.driveId) {
          try { await gfetch(`/drive/v3/files/${n.driveId}`, { method: 'DELETE' }); }
          catch (e) { if (e.status !== 404) throw e; }
        }
        notes.delete(n.id); await idb.del('notes', n.id);
        continue;
      }
      if (f) continue;
      const localChanged = n.updated > (n.syncedAt || 0);
      if (n.driveId && !localChanged) {
        // Deleted on another device.
        if (current && current.id === n.id) continue;
        notes.delete(n.id); await idb.del('notes', n.id); changedList = true;
      } else if (!isEmptyNote(n)) {
        n.driveId = null;
        await uploadNote(n, folder);
      }
    }
    settings.lastSync = Date.now();
    await saveSettings();
    setSyncState('ok');
    if (changedList && !current) renderList();
    updateAccountUI();
  } catch (e) {
    console.error(e);
    if (e instanceof AuthNeeded) setSyncState('signin');
    else { setSyncState('error'); toast(e.message.slice(0, 120)); }
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; queueSync(1500); }
  }
}

function queueSync(delay = 3000) {
  if (!settings.autoSync || !settings.signedIn) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}
window.addEventListener('online', () => queueSync(500));

syncBtn.onclick = async () => {
  if (!settings.clientId) { openSettings(); toast('Set up Google backup first'); return; }
  if (!hasToken()) {
    try { await signIn(); } catch (e) { toast(e.message); setSyncState('signin'); return; }
  }
  await sync();
  if (syncBtn.dataset.state === 'ok') toast('Synced with Google Drive');
};

/* ================= Settings ================= */
const dlg = $('#settingsDlg');
const clientIdInput = $('#clientIdInput');
function openSettings() {
  clientIdInput.value = settings.clientId;
  $('#autoSyncInput').checked = settings.autoSync;
  updateAccountUI();
  if (settings.clientId) loadGis().catch(() => {});
  dlg.showModal();
}
function updateAccountUI() {
  const st = $('#acctStatus');
  if (settings.signedIn) {
    st.textContent = '✓ Connected' + (settings.email ? ' as ' + settings.email : '') +
      (settings.lastSync ? ' · last sync ' + fmtDate(settings.lastSync) : '');
  } else st.textContent = 'Not connected';
  $('#signOutBtn').hidden = !settings.signedIn;
  $('#syncNowBtn').hidden = !settings.signedIn;
  $('#signInBtn').textContent = settings.signedIn ? 'Reconnect' : 'Connect Google';
}
$('#settingsBtn').onclick = openSettings;
clientIdInput.addEventListener('change', () => {
  settings.clientId = clientIdInput.value.trim();
  saveSettings();
  if (settings.clientId) loadGis().catch(() => {});
});
$('#autoSyncInput').onchange = (e) => { settings.autoSync = e.target.checked; saveSettings(); };
$('#signInBtn').onclick = async () => {
  settings.clientId = clientIdInput.value.trim();
  await saveSettings();
  try {
    await signIn();
    toast('Google account connected');
    await sync();
  } catch (e) { toast(e.message); }
};
$('#syncNowBtn').onclick = () => syncBtn.click();
$('#signOutBtn').onclick = () => { signOut(); toast('Disconnected — notes stay on this phone'); };

$('#exportBtn').onclick = async () => {
  await saveNow();
  const data = [...notes.values()].filter((n) => !n.deleted)
    .map(({ driveId, syncedAt, ...rest }) => rest);
  const blob = new Blob([JSON.stringify({ app: 'notes', version: 1, notes: data })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `notes-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('#importBtn').onclick = () => $('#importInput').click();
$('#importInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    let count = 0;
    for (const n of data.notes || []) {
      if (!n.id) continue;
      const local = notes.get(n.id);
      if (local && local.updated >= n.updated) continue;
      const merged = { ...(local || {}), ...n, deleted: false };
      notes.set(n.id, merged);
      await idb.put('notes', merged);
      count++;
    }
    renderList();
    toast(`Imported ${count} note${count === 1 ? '' : 's'}`);
    queueSync(500);
  } catch { toast('That file is not a notes backup'); }
};

/* ================= Boot ================= */
(async function init() {
  const s = await idb.get('kv', 'settings');
  if (s) Object.assign(settings, s);
  for (const n of await idb.all('notes')) notes.set(n.id, n);
  renderList();
  setSyncState(!settings.signedIn ? 'off' : hasToken() ? 'ok' : 'signin');
  if (settings.clientId && settings.signedIn) loadGis().catch(() => {});

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);

  const params = new URLSearchParams(location.search);
  if (params.has('shared')) {
    history.replaceState(null, '', location.pathname);
    await consumeShared();
  }
  if (hasToken()) queueSync(800);
})();
