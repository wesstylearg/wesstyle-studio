const API = (window.WESSTYLE_API || '').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone'), fileInput = $('fileInput');
let resultUrl = null;

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => fileInput.files[0] && handle(fileInput.files[0]));
['dragenter', 'dragover'].forEach((e) => dropzone.addEventListener(e, (ev) => { ev.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((e) => dropzone.addEventListener(e, (ev) => { ev.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (ev) => ev.dataTransfer.files[0] && handle(ev.dataTransfer.files[0]));
$('resetBtn').addEventListener('click', reset);

async function handle(file) {
  if (!file.type.startsWith('image/')) return alert('Seleccioná un archivo de imagen válido.');
  if (file.size > 15 * 1024 * 1024) return alert('La imagen supera los 15 MB.');

  $('uploadCard').classList.add('hidden');
  $('resultCard').classList.remove('hidden');
  $('error').classList.add('hidden');
  $('downloadBtn').classList.add('hidden');
  $('result').removeAttribute('src');
  $('original').src = URL.createObjectURL(file);
  $('loader').classList.remove('hidden');

  const form = new FormData();
  form.append('image', file);
  try {
    const res = await fetch(`${API}/api/remove-bg`, { method: 'POST', body: form });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Error al procesar la imagen');
    }
    const blob = await res.blob();
    resultUrl = URL.createObjectURL(blob);
    $('result').src = resultUrl;
    $('downloadBtn').href = resultUrl;
    $('downloadBtn').classList.remove('hidden');
  } catch (err) {
    $('error').textContent = err.message;
    $('error').classList.remove('hidden');
  } finally {
    $('loader').classList.add('hidden');
  }
}

function reset() {
  fileInput.value = '';
  $('resultCard').classList.add('hidden');
  $('uploadCard').classList.remove('hidden');
}
