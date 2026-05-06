require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const jwt = require('jsonwebtoken');
const pdfParse = require('pdf-parse');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'tesjuamap_secret';
const ADMIN_USER = process.env.ADMIN_USER || 'Tesla';
const ADMIN_PASS = process.env.ADMIN_PASS || 'juanalaloca2024!';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'TesJuaMap API', version: '1.0.0', by: 'JZ' });
});

// ─── LOGIN SUPERADMIN ──────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign(
      { username, role: 'superadmin' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    return res.json({ ok: true, token, role: 'superadmin', username });
  }
  return res.status(401).json({ error: 'Credenciales incorrectas' });
});

// ─── VERIFY TOKEN ──────────────────────────────────────────────────────────────
app.get('/api/verify', authMiddleware, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// ─── UPDATE API KEY (solo superadmin) ─────────────────────────────────────────
let runtimeApiKey = GEMINI_KEY;
app.post('/api/admin/apikey', authMiddleware, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Sin permisos' });
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key requerida' });
  runtimeApiKey = apiKey;
  res.json({ ok: true, message: 'API key actualizada correctamente' });
});

// ─── EXTRAER TEXTO DE ARCHIVO ──────────────────────────────────────────────────
async function extractText(file) {
  const ext = file.originalname.split('.').pop().toLowerCase();
  if (ext === 'docx' || ext === 'doc') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return { text: result.value, type: 'text' };
  }
  if (ext === 'pdf') {
    const result = await pdfParse(file.buffer);
    return { text: result.text, type: 'text' };
  }
  if (['jpg','jpeg','png','webp'].includes(ext)) {
    const b64 = file.buffer.toString('base64');
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    return { b64, mimeType, type: 'image' };
  }
  throw new Error('Formato no soportado');
}

// ─── LLAMAR A GEMINI ───────────────────────────────────────────────────────────
async function callGemini(parts, systemPrompt) {
  const key = runtimeApiKey;
  if (!key) throw new Error('API key de Gemini no configurada');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
  const contents = [{ role: 'user', parts: [...parts, { text: systemPrompt }] }];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 3000 }
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return raw.replace(/```json|```/g, '').trim();
}

// ─── GENERAR MAPA MENTAL ───────────────────────────────────────────────────────
app.post('/api/generate/mindmap', upload.single('file'), async (req, res) => {
  try {
    const parts = [];
    const userText = req.body.text || '';

    if (req.file) {
      const extracted = await extractText(req.file);
      if (extracted.type === 'image') {
        parts.push({ inlineData: { mimeType: extracted.mimeType, data: extracted.b64 } });
      } else {
        parts.push({ text: 'Contenido del documento:\n\n' + extracted.text });
      }
    }
    if (userText) parts.push({ text: 'Texto del usuario:\n\n' + userText });

    const prompt = `Analiza el contenido y genera un mapa mental estructurado.

IMPORTANTE - Detecta el TEMA y adapta los colores:
- Religión/Iglesia/Biblia/Espiritual → colores dorados: root "#B8860B", branches ["#DAA520","#CD853F","#8B6914","#A0522D","#6B4423","#9B7B3D"]
- Ciencia/Tecnología/Ingeniería → azules: root "#1E40AF", branches ["#3B82F6","#06B6D4","#6366F1","#0EA5E9","#14B8A6","#8B5CF6"]
- Historia/Social/Humanidades → cálidos: root "#7C2D12", branches ["#C2410C","#B45309","#92400E","#78350F","#6B21A8","#BE185D"]
- Salud/Medicina/Biología → verdes: root "#065F46", branches ["#10B981","#059669","#16A34A","#15803D","#047857","#0F766E"]
- Arte/Literatura/Cultura → púrpuras: root "#4C1D95", branches ["#7C3AED","#9333EA","#A855F7","#C026D3","#DB2777","#E11D48"]
- General → multicolor: root "#7c6ef7", branches ["#7c6ef7","#34d399","#f97316","#60a5fa","#f472b6","#a78bfa"]

REGLAS:
- root: tema principal (máx 3 palabras)
- 5-6 branches
- Cada branch: 2-4 children (máx 5 palabras c/u)
- Textos CORTOS y precisos
- Responde SOLO JSON válido sin backticks

FORMATO:
{"root":"Tema","color":"#COLOR","theme":"religion|science|history|health|art|general","branches":[{"label":"Rama","color":"#COLOR","children":["hijo1","hijo2","hijo3"]}]}`;

    const raw = await callGemini(parts, prompt);
    const data = JSON.parse(raw);
    res.json({ ok: true, data });
  } catch (e) {
    console.error('Mindmap error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GENERAR PRESENTACIÓN ──────────────────────────────────────────────────────
app.post('/api/generate/slides', upload.single('file'), async (req, res) => {
  try {
    const parts = [];
    const userText = req.body.text || '';

    if (req.file) {
      const extracted = await extractText(req.file);
      if (extracted.type === 'image') {
        parts.push({ inlineData: { mimeType: extracted.mimeType, data: extracted.b64 } });
      } else {
        parts.push({ text: 'Contenido del documento:\n\n' + extracted.text });
      }
    }
    if (userText) parts.push({ text: 'Texto del usuario:\n\n' + userText });

    const prompt = `Analiza el contenido y genera una presentación académica/educativa de alta calidad.

DETECTA el tema y define el estilo visual:
- Religión/Iglesia/Biblia/Espiritual → theme:"religion", palette:{bg:"1A1200",accent:"D4AF37",accent2:"C8960C",text:"FFF8DC",surface:"2A1F00",highlight:"F0D060"}
- Ciencia/Tecnología/Ingeniería → theme:"science", palette:{bg:"020B18",accent:"00D4FF",accent2:"0080FF",text:"E0F4FF",surface:"0A1628",highlight:"00FFCC"}
- Historia/Social/Humanidades → theme:"history", palette:{bg:"1C0F00",accent:"CD853F",accent2:"D2691E",text:"FFF5E4",surface:"2C1800",highlight:"DAA520"}
- Salud/Medicina/Biología → theme:"health", palette:{bg:"001A0F",accent:"00E676",accent2:"00C853",text:"E0FFE8",surface:"002A18",highlight:"69F0AE"}
- Arte/Literatura/Cultura → theme:"art", palette:{bg:"120020",accent:"E040FB",accent2:"AA00FF",text:"F8E8FF",surface:"1E0030",highlight:"FF80AB"}
- General/Educación → theme:"general", palette:{bg:"0D0D0D",accent:"7C6EF7",accent2:"34D399",text:"F0F0F0",surface:"161616",highlight:"F97316"}

REGLAS DE CONTENIDO:
- 8-12 diapositivas según la profundidad del tema
- Primera slide SIEMPRE tipo "title" con impacto visual
- Incluir slides tipo "quote" para frases clave o versículos (si es religioso)
- Última slide tipo "end"
- Tipos disponibles: "title", "section", "content", "list", "quote", "image_desc", "end"
- Contenido RICO, bien desarrollado, académico pero accesible
- Para iglesia: incluir versículos bíblicos relevantes en las quotes
- Responde SOLO JSON sin backticks

FORMATO:
{
  "title": "Título de la presentación",
  "theme": "religion",
  "palette": {"bg":"1A1200","accent":"D4AF37","accent2":"C8960C","text":"FFF8DC","surface":"2A1F00","highlight":"F0D060"},
  "slides": [
    {"type":"title","heading":"Título","body":"Subtítulo o versículo introductorio","icon":"✝"},
    {"type":"section","heading":"Nombre sección","body":"Introducción a la sección"},
    {"type":"content","heading":"Título del punto","body":"Desarrollo del contenido, máx 60 palabras, bien elaborado"},
    {"type":"list","heading":"Puntos clave","points":["Punto 1 bien detallado","Punto 2","Punto 3","Punto 4"]},
    {"type":"quote","text":"Cita o versículo bíblico importante","source":"Referencia (ej: Juan 3:16)"},
    {"type":"end","heading":"Cierre","body":"Mensaje final inspirador","icon":"🙏"}
  ]
}`;

    const raw = await callGemini(parts, prompt);
    const data = JSON.parse(raw);
    res.json({ ok: true, data });
  } catch (e) {
    console.error('Slides error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── ADMIN: STATUS ─────────────────────────────────────────────────────────────
app.get('/api/admin/status', authMiddleware, (req, res) => {
  res.json({
    ok: true,
    geminiConfigured: !!runtimeApiKey,
    keyPreview: runtimeApiKey ? runtimeApiKey.slice(0, 8) + '...' : 'No configurada',
    uptime: process.uptime(),
    version: '1.0.0',
    by: 'TesJua - JZ'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 TesJuaMap API corriendo en puerto ${PORT}`);
  console.log(`🔑 Gemini Key: ${GEMINI_KEY ? GEMINI_KEY.slice(0,8)+'...' : 'NO CONFIGURADA'}`);
  console.log(`👤 Admin: ${ADMIN_USER}`);
});
