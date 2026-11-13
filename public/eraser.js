const API = (window.WESSTYLE_API || '').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone'), fileInput = $('fileInput');
const base = $('base'), overlay = $('overlay');
const SEND_MAX = 512;      // tamaño que se envía al modelo (SD 1.5)
const DISPLAY_MAX = 800;   // tamaño de trabajo en pantalla
let orig = null;           // imagen original a resolución completa
let maskCanvas = null;     // máscara de trazos (blanco sobre transparente), tamaño de pantalla
let strokes = [];          // [{ size, points: [[x,y],...] }]
let current = null;
let busy = false;

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => fileInput.files[0] && load(fileInput.files[0]));
['dragenter', 'dragover'].forEach((e) => dropzone.addEventListener(e, (ev) => { ev.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((e) => dropzone.addEventListener(e, (ev) => { ev.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (ev) => ev.dataTransfer.files[0] && load(ev.dataTransfer.files[0]));

$('undoBtn').addEventListener('click', () => { strokes.pop(); redraw(); });
$('clearBtn').addEventListener('click', () => { strokes = []; redraw(); });
$('goBtn').addEventListener('click', erase);
$('cancelBtn').addEventListener('click', reset);
$('resetBtn').addEventListener('click', reset);
$('backBtn').addEventListener('click', () => { $('resultCard').classList.add('hidden'); $('editCard').classList.remove('hidden'); });

function load(file) {
  if (!file.type.startsWith('image/')) return alert('Seleccioná un archivo de imagen válido.');
  if (file.size > 15 * 1024 * 1024) return alert('La imagen supera los 15 MB.');
  const img = new Image();
  img.onload = () => {
    orig = img;
    const s = Math.min(1, DISPLAY_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
    for (const c of [base, overlay]) { c.width = w; c.height = h; }
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = w; maskCanvas.height = h;
    base.getContext('2d').drawImage(img, 0, 0, w, h);
    strokes = [];
    redraw();
    $('uploadCard').classList.add('hidden');
    $('editCard').classList.remove('hidden');
  };
  img.src = URL.createObjectURL(file);
}

function strokePath(ctx, st) {
  ctx.lineWidth = st.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (st.points.length === 1) ctx.lineTo(st.points[0][0] + 0.01, st.points[0][1]);
  ctx.stroke();
}

function redraw() {
  const o = overlay.getContext('2d'), m = maskCanvas.getContext('2d');
  o.clearRect(0, 0, overlay.width, overlay.height);
  m.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  o.strokeStyle = 'rgba(133,98,255,.55)';
  m.strokeStyle = '#fff';
  for (const st of strokes) { strokePath(o, st); strokePath(m, st); }
}

// Pincel con puntero (mouse, táctil y lápiz)
function pos(e) {
  const r = overlay.getBoundingClientRect();
  return [(e.clientX - r.left) * (overlay.width / r.width), (e.clientY - r.top) * (overlay.height / r.height)];
}
overlay.addEventListener('pointerdown', (e) => {
  overlay.setPointerCapture(e.pointerId);
  const r = overlay.getBoundingClientRect();
  const size = +$('brush').value * (overlay.width / r.width);
  current = { size, points: [pos(e)] };
  strokes.push(current);
  redraw();
});
overlay.addEventListener('pointermove', (e) => { if (current) { current.points.push(pos(e)); redraw(); } });
['pointerup', 'pointercancel'].forEach((ev) => overlay.addEventListener(ev, () => { current = null; }));

const toBlob = (c) => new Promise((res) => c.toBlob(res, 'image/png'));
const r8 = (n) => Math.max(256, Math.round(n / 8) * 8);

function showEditError(msg) { $('editError').textContent = msg; $('editError').classList.remove('hidden'); }

async function erase() {
  if (busy) return;
  if (!strokes.length) return showEditError('Pintá primero sobre el objeto que querés borrar.');
  busy = true;
  $('editError').classList.add('hidden');

  // Versión reducida para el modelo
  const s = Math.min(1, SEND_MAX / Math.max(orig.naturalWidth, orig.naturalHeight));
  const w = r8(orig.naturalWidth * s), h = r8(orig.naturalHeight * s);
  const imgC = document.createElement('canvas'); imgC.width = w; imgC.height = h;
  imgC.getContext('2d').drawImage(orig, 0, 0, w, h);
  const mC = document.createElement('canvas'); mC.width = w; mC.height = h;
  const mctx = mC.getContext('2d');
  mctx.fillStyle = '#000'; mctx.fillRect(0, 0, w, h);
  mctx.filter = 'blur(1px)';
  mctx.drawImage(maskCanvas, 0, 0, w, h);
  // binariza: blanco = pintar, negro = conservar (con un pequeño margen)
  const d = mctx.getImageData(0, 0, w, h);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = d.data[i] > 24 ? 255 : 0;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255;
  }
  mctx.putImageData(d, 0, 0);

  $('editCard').classList.add('hidden');
  $('resultCard').classList.remove('hidden');
  $('error').classList.add('hidden');
  $('downloadBtn').classList.add('hidden');
  $('result').removeAttribute('src');
  $('loader').classList.remove('hidden');

  try {
    const form = new FormData();
    form.append('image', await toBlob(imgC), 'image.png');
    form.append('mask', await toBlob(mC), 'mask.png');
    const res = await fetch(`${API}/api/erase`, { method: 'POST', body: form });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Error al borrar el objeto');
    }
    const out = await createImageBitmap(await res.blob());
    const finalBlob = await composite(out);
    const url = URL.createObjectURL(finalBlob);
    $('result').src = url;
    $('downloadBtn').href = url;
    $('downloadBtn').classList.remove('hidden');
  } catch (err) {
    $('error').textContent = err.message;
    $('error').classList.remove('hidden');
  } finally {
    $('loader').classList.add('hidden');
    busy = false;
  }
}

// Pega solo la zona pintada del resultado sobre la imagen original a resolución completa.
async function composite(out) {
  const W = orig.naturalWidth, H = orig.naturalHeight;
  const fill = document.createElement('canvas'); fill.width = W; fill.height = H;
  const fctx = fill.getContext('2d');
  fctx.drawImage(out, 0, 0, W, H);
  const soft = Math.max(2, Math.round(W / 300));
  const grow = document.createElement('canvas'); grow.width = W; grow.height = H;
  const gctx = grow.getContext('2d');
  gctx.filter = `blur(${soft}px)`;
  gctx.drawImage(maskCanvas, 0, 0, W, H);
  gctx.drawImage(maskCanvas, 0, 0, W, H); // refuerza el borde difuminado
  fctx.globalCompositeOperation = 'destination-in';
  fctx.drawImage(grow, 0, 0);

  const final = document.createElement('canvas'); final.width = W; final.height = H;
  const ctx = final.getContext('2d');
  ctx.drawImage(orig, 0, 0, W, H);
  ctx.drawImage(fill, 0, 0);
  return toBlob(final);
}

function reset() {
  fileInput.value = '';
  orig = null; strokes = [];
  $('editCard').classList.add('hidden');
  $('resultCard').classList.add('hidden');
  $('uploadCard').classList.remove('hidden');
}
