import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, handle_file } from '@gradio/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const HF_TOKEN = process.env.HF_TOKEN;

// CORS para permitir el frontend alojado en Firebase Hosting (ALLOWED_ORIGINS separado por comas en .env)
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (!ALLOWED.length) {
    res.set('Access-Control-Allow-Origin', origin || '*');
  } else if (origin && ALLOWED.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  } else if (origin) {
    return res.status(403).json({ error: 'Origen no autorizado' });
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Expose-Headers', 'X-Retry-After, X-Seed, X-RateLimit-Remaining');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Límite de 15 usos por hora por visitante (IP) en todas las herramientas
const RATE_MAX = 15;
const RATE_WINDOW = 60 * 60 * 1000;
const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (entry.reset <= now) hits.delete(ip);
}, 10 * 60 * 1000).unref();

app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = hits.get(ip);
  if (!entry || entry.reset <= now) {
    entry = { count: 0, reset: now + RATE_WINDOW };
    hits.set(ip, entry);
  }
  entry.count += 1;
  const remaining = Math.max(0, RATE_MAX - entry.count);
  res.set('X-RateLimit-Limit', String(RATE_MAX));
  res.set('X-RateLimit-Remaining', String(remaining));
  if (entry.count > RATE_MAX) {
    const mins = Math.ceil((entry.reset - now) / 60000);
    res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
    return res.status(429).json({
      error: `Alcanzaste el límite de ${RATE_MAX} usos por hora. Probá de nuevo en ${mins} min.`,
    });
  }
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Solo se permiten imágenes')),
});

// Mejora de imagen: Real-ESRGAN x4 vía Space de Hugging Face (la API serverless ya no lo sirve).
const UPSCALE_JOB = {
  space: 'Nick088/Real-ESRGAN_Pytorch',
  run: (client, image) => client.predict('/predict', { img: image, size_modifier: 4 }),
};

async function runSpace(space, runner, file) {
  const client = await Client.connect(space, { token: HF_TOKEN });
  const blob = new Blob([file.buffer], { type: file.mimetype });
  const result = await runner(client, handle_file(blob));
  const out = [].concat(result.data).flat().find((d) => d && (d.url || d.path));
  if (!out) throw new Error('Respuesta inesperada del modelo');
  const imgRes = await fetch(out.url || out.path, { headers: { Authorization: `Bearer ${HF_TOKEN}` } });
  if (!imgRes.ok) throw new Error(`No se pudo descargar el resultado (${imgRes.status})`);
  return {
    type: imgRes.headers.get('content-type') || 'image/png',
    buffer: Buffer.from(await imgRes.arrayBuffer()),
  };
}

function friendlyError(err) {
  const detail = err?.message || err?.title || JSON.stringify(err);
  if (/ZeroGPU|quota/i.test(detail)) {
    return 'Se agotó la cuota diaria gratuita de GPU de Hugging Face. Probá de nuevo más tarde (se renueva cada día) o usá un token de una cuenta con cuota disponible.';
  }
  const cause = err?.cause?.code || err?.cause?.message || '';
  return `Error con Hugging Face: ${detail}${cause ? ' (' + cause + ')' : ''}`;
}

function handler(getJob) {
  return async (req, res) => {
    if (!HF_TOKEN || HF_TOKEN.includes('tu_token')) {
      return res.status(500).json({ error: 'Falta configurar HF_TOKEN en el archivo .env' });
    }
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
    const job = getJob(req);
    if (!job) return res.status(400).json({ error: 'Modelo no válido' });
    try {
      const out = await runSpace(job.space, job.run, req.file);
      res.set('Content-Type', out.type).send(out.buffer);
    } catch (err) {
      console.error('Error:', err);
      res.status(502).json({ error: friendlyError(err) });
    }
  };
}

app.post('/api/remove-bg', upload.single('image'),
  handler(() => ({ space: 'briaai/BRIA-RMBG-1.4', run: (c, image) => c.predict('/run', { image }) })));

app.post('/api/upscale', upload.single('image'),
  handler(() => UPSCALE_JOB));

// Borrar objetos: inpainting con Cloudflare Workers AI
// (@cf/runwayml/stable-diffusion-v1-5-inpainting) vía API REST. Máscara: blanco = pintar, negro = conservar.
const CF_MODEL = '@cf/runwayml/stable-diffusion-v1-5-inpainting';
const NEG_DEFAULT = 'blurry, distorted, deformed, low quality, text, watermark, logo';

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

async function cfCall(body) {
  const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || type.includes('json')) {
    const data = await r.json().catch(() => ({}));
    const msg = data?.errors?.[0]?.message || `Cloudflare respondió ${r.status}`;
    const e = new Error(msg);
    e.status = r.status === 429 || /neurons|daily|allocation|limit/i.test(msg) ? 429 : 502;
    throw e;
  }
  return Buffer.from(await r.arrayBuffer());
}

async function cfInpaint({ image, mask, prompt, negative }) {
  const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || CF_ACCOUNT_ID.includes('tu_')) {
    const e = new Error('Falta configurar CF_ACCOUNT_ID y CF_API_TOKEN en el archivo .env');
    e.status = 500;
    throw e;
  }
  const { width, height } = pngSize(image);
  const body = {
    prompt,
    negative_prompt: negative,
    image_b64: image.toString('base64'),
    mask: [...mask],
    width,
    height,
    num_steps: 20,
    strength: 1,
    guidance: 7.5,
  };
  // A veces el modelo devuelve un PNG vacío (negro, <3 KB): reintenta con otra semilla.
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await cfCall({ ...body, seed: Math.floor(Math.random() * 2 ** 31) });
    if (out.length > 3000) return out;
  }
  const e = new Error('El modelo devolvió una imagen vacía. Probá con otra imagen o descripción.');
  e.status = 502;
  throw e;
}
function cfRoute(buildArgs) {
  return async (req, res) => {
    const image = req.files?.image?.[0];
    const mask = req.files?.mask?.[0];
    if (!image || !mask) return res.status(400).json({ error: 'Faltan la imagen o la máscara' });
    if (image.mimetype !== 'image/png' || mask.mimetype !== 'image/png') {
      return res.status(400).json({ error: 'La imagen y la máscara deben ser PNG' });
    }
    try {
      const out = await cfInpaint({ image: image.buffer, mask: mask.buffer, ...buildArgs(req) });
      res.set('Content-Type', 'image/png').send(out);
    } catch (err) {
      console.error('Error:', err);
      const msg = err.status === 429
        ? 'Se agotó el cupo diario gratuito de Cloudflare (10.000 Neurons). Se renueva a las 00:00 UTC.'
        : err.name === 'TimeoutError' ? 'El modelo tardó demasiado. Probá de nuevo.' : err.message;
      res.status(err.status || 502).json({ error: msg });
    }
  };
}

const imageAndMask = upload.fields([{ name: 'image', maxCount: 1 }, { name: 'mask', maxCount: 1 }]);

app.post('/api/erase', imageAndMask, cfRoute(() => ({
  prompt: 'clean empty background seamlessly matching the surroundings, same texture and lighting, no objects',
  negative: `${NEG_DEFAULT}, person, object, animal`,
})));
// Generación de imágenes con Pollinations. Se hace desde el servidor para evitar CORS.
// Sin clave: el plan gratuito permite 1 imagen cada 45 s por IP (el servidor es "la IP", así que el límite es compartido).
// Con POLLINATIONS_KEY en .env se usa la API con clave, sin ese límite.
const GEN_SIZES = { square: [1024, 1024], wide: [1344, 768], tall: [768, 1344], portrait: [896, 1120] };
const FREE_COOLDOWN = 45;
let freeBlockedUntil = 0;

const retryError = (res, seconds) =>
  res.status(429).set('X-Retry-After', String(seconds)).json({
    error: `El plan gratuito de Pollinations permite 1 imagen cada 45 segundos. Probá de nuevo en ${seconds} s.`,
    retryAfter: seconds,
  });

app.post('/api/generate', express.json({ limit: '10kb' }), async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim().slice(0, 600);
  if (prompt.length < 3) return res.status(400).json({ error: 'Escribí una descripción de al menos 3 caracteres' });
  const [width, height] = GEN_SIZES[req.body?.ratio] || GEN_SIZES.square;
  const seed = Number.isInteger(req.body?.seed) ? req.body.seed : Math.floor(Math.random() * 1e9);
  const key = process.env.POLLINATIONS_KEY;
  const hasKey = key && !key.includes('tu_');

  const wait = Math.ceil((freeBlockedUntil - Date.now()) / 1000);
  if (!hasKey && wait > 0) return retryError(res, wait);

  const params = new URLSearchParams({ width, height, seed, model: 'flux', nologo: 'true', private: 'true', enhance: 'false' });
  const url = hasKey
    ? `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?${params}`
    : `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
  const headers = hasKey ? { Authorization: `Bearer ${key}` } : {};

  try {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await fetch(url, { headers, signal: AbortSignal.timeout(90000) });
      const type = last.headers.get('content-type') || '';
      if (last.ok && type.startsWith('image/')) {
        if (!hasKey) freeBlockedUntil = Date.now() + FREE_COOLDOWN * 1000;
        res.set('Content-Type', type).set('X-Seed', String(seed));
        if (!hasKey) res.set('X-Retry-After', String(FREE_COOLDOWN));
        return res.send(Buffer.from(await last.arrayBuffer()));
      }
      if (last.status === 402 || last.status === 429) break; // límite: no insistir
      if (last.status < 500) break;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    const body = await last.json().catch(() => ({}));
    const msg = body?.error?.message || '';
    if (last.status === 402 || last.status === 429) {
      const secs = Number(/after (\d+)s/i.exec(msg)?.[1]) || FREE_COOLDOWN;
      if (!hasKey) freeBlockedUntil = Date.now() + secs * 1000;
      if (/free limit/i.test(msg) || !hasKey) return retryError(res, secs);
      return res.status(402).json({ error: 'La clave de Pollinations no tiene saldo (pollen) disponible.' });
    }
    if (last.status === 401) return res.status(401).json({ error: 'La clave POLLINATIONS_KEY no es válida.' });
    res.status(502).json({ error: `Pollinations respondió ${last.status}` });
  } catch (err) {
    console.error('Error:', err);
    res.status(502).json({ error: err.name === 'TimeoutError' ? 'La generación tardó demasiado. Probá de nuevo.' : `No se pudo generar la imagen: ${err.message}` });
  }
});
// Páginas: /remove-bg, /upscaler, /expand, /eraser y /generate

const staticDir = express.static(path.join(__dirname, 'public'), { extensions: ['html'] });
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.redirect('/wesstyle-studio/'));
app.use('/wesstyle-studio', staticDir);
app.use(staticDir);

app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));

app.listen(PORT, () => console.log(`Wesstyle en http://localhost:${PORT}  (/remove-bg · /upscaler)`));



