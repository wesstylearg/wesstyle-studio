const API = (window.WESSTYLE_API || '').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
let busy = false;
let timer = null;

// Cuenta regresiva en el botón cuando el plan gratuito exige esperar
function cooldown(seconds) {
  clearInterval(timer);
  const btns = [$('goBtn'), $('againBtn')];
  let left = Math.ceil(seconds);
  const tick = () => {
    if (left <= 0) {
      clearInterval(timer);
      btns.forEach((b) => { b.disabled = false; });
      $('goBtn').textContent = 'Generar';
      $('againBtn').textContent = 'Otra variante';
      return;
    }
    btns.forEach((b) => { b.disabled = true; });
    $('goBtn').textContent = `Esperá ${left} s`;
    $('againBtn').textContent = `Esperá ${left} s`;
    left--;
  };
  tick();
  timer = setInterval(tick, 1000);
}

$('goBtn').addEventListener('click', () => generate());
$('againBtn').addEventListener('click', () => generate());
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });

// Recorta el 7% inferior (y 3.5% de cada lado para mantener la proporción) y quita la marca de agua abajo a la derecha.
async function cropWatermark(blob) {
  const bmp = await createImageBitmap(blob);
  const w = Math.round(bmp.width * 0.93);
  const h = Math.round(bmp.height * 0.93);
  const sx = Math.round(bmp.width * 0.035);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, sx, 0, w, h, 0, 0, w, h);
  bmp.close();
  const mime = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return new Promise((res) => c.toBlob(res, mime, 0.95));
}

async function generate() {
  if (busy) return;
  const prompt = $('prompt').value.trim();
  const err = $('error');
  err.classList.add('hidden');
  if (prompt.length < 3) {
    err.textContent = 'Escribí una descripción de al menos 3 caracteres.';
    return err.classList.remove('hidden');
  }
  busy = true;
  $('goBtn').disabled = $('againBtn').disabled = true;
  $('resultStage').classList.remove('hidden');
  $('resultActions').classList.add('hidden');
  $('result').removeAttribute('src');
  $('loader').classList.remove('hidden');

  try {
    const res = await fetch(`${API}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ratio: document.querySelector('input[name="ratio"]:checked').value }),
    });
    const retry = Number(res.headers.get('X-Retry-After')) || 0;
    if (retry) cooldown(retry);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Error al generar la imagen');
    }
    const raw = await res.blob();
    const blob = await cropWatermark(raw);
    const url = URL.createObjectURL(blob);
    $('result').src = url;
    $('downloadBtn').href = url;
    $('downloadBtn').download = 'wesstyle-generada.' + (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    $('resultActions').classList.remove('hidden');
  } catch (e) {
    $('resultStage').classList.add('hidden');
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    $('loader').classList.add('hidden');
    if (!$('goBtn').textContent.startsWith('Esper')) $('goBtn').disabled = $('againBtn').disabled = false;
    busy = false;
  }
}
