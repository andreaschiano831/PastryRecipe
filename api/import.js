// Inserimento ricette con AI dal server (come in ANDRE-S-RECIPE):
// la chiave Groq resta su Vercel (variabile GROQ_API_KEY) e non serve più inserirla su ogni dispositivo.
// GET  /api/import            -> { ok, configured }  (controllo stato)
// POST /api/import  { image } -> { recipes: [...] }  (una foto, data URL jpeg/png/webp)
// POST /api/import  { text }  -> { recipes: [...] }
// Le ricette tornano già nel formato dell'app: { n, c, s, piatto, p, i:[[nome, quantità, unità]] }

const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const VISION = [process.env.GROQ_VISION_MODEL, 'qwen/qwen3.8-27b', 'meta-models/muse-spark-open', 'meta-llama/llama-4-scout-17b-16e-instruct'].filter(Boolean);
const TEXT = [process.env.GROQ_TEXT_MODEL, 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'].filter(Boolean);

const SECTIONS = { colazioni: 'Monoporzioni', 'fine-dining': 'Fine Dining', gelateria: 'Gelateria', torte: 'Torte' };
const CATEGORIES = ['Creme', 'Paste', 'Torte', 'Lievitati', 'Pasticcini', 'Marmellate', 'Ganache', 'Mousse', 'Gelatine', 'Gelati', 'Sorbetti', 'Semifreddi', 'Granite', 'Basi', 'Glasse', 'Biscotti', 'Altro'];

class AIError extends Error { constructor(msg, status) { super(msg); this.status = status || 502; } }

function prompt() {
  return `Sei l'assistente di un pastry chef stellato. Estrai TUTTE le ricette presenti nel materiale e restituisci SOLO un oggetto JSON, senza testo fuori dal JSON, in questo formato:
{"recipes":[{"name":"","section":"","category":"","dish_group":"","yield_note":"","ingredients":[{"name":"","quantity":0,"unit":"g","note":""}],"steps":[{"body":"","duration_min":null,"temperature":""}],"notes":""}]}
REGOLE:
1. Ogni preparazione con un proprio titolo (es. "Massa macaron", "Cremoso pesca", "Glassa") è una ricetta SEPARATA nell'array. Se fanno parte dello stesso piatto o dolce, metti il nome del piatto in "dish_group".
2. Leggi ogni riga: non saltare ingredienti. "quantity" è un numero (usa il punto come decimale) oppure null se q.b.
3. Unità ammesse: g, kg, ml, l, cl, n°, q.b., foglio, bacca, %. Converti "gr" in "g", uova/tuorli contati in "n°". Se le quantità sono in once/cup/cucchiai convertile in g/ml.
4. Traduci tutto in italiano professionale di pasticceria.
5. "steps": dividi il procedimento in passaggi brevi e ordinati, uno per azione. Se un passaggio indica un tempo, metti i minuti in "duration_min" (numero intero); se indica una temperatura scrivila in "temperature" (es. "170°C ventilato", "82°C").
6. "section": scegli il più adatto tra ${Object.values(SECTIONS).map((x) => `"${x}"`).join(', ')}.
7. "category" deve essere una di: ${CATEGORIES.join(', ')}.
8. "yield_note" è la resa se indicata (es. "per 60 pezzi", "stampo 20 cm"), altrimenti "".
9. Non inventare ingredienti o quantità che non vedi. Ignora pubblicità, commenti e ricette solo citate senza ingredienti.`;
}

const gone = (m) => /does not exist|decommissioned|deprecated|not found|do not have access|model_not_found|not supported/i.test(m);
const stripThink = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

async function groqChat({ system, user, image, json }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new AIError('GROQ_API_KEY non configurata su Vercel', 503);
  const models = [...new Set(image ? VISION : TEXT)];
  let last = '';
  for (const model of models) {
    const content = image ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: image } }] : user;
    const body = { model, temperature: 0.1, max_completion_tokens: 8000, messages: [{ role: 'system', content: system }, { role: 'user', content }] };
    if (json) body.response_format = { type: 'json_object' };
    if (model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
    else if (model.startsWith('qwen/')) body.reasoning_effort = 'none';
    const call = (b) => fetch(GROQ_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(b) });
    let res = await call(body);
    let data = await res.json().catch(() => null);
    if (!res.ok && res.status === 400 && body.reasoning_effort && /reasoning/i.test((data && data.error && data.error.message) || '')) {
      delete body.reasoning_effort; res = await call(body); data = await res.json().catch(() => null);
    }
    const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (res.ok && out) return stripThink(out);
    const msg = (data && data.error && data.error.message) || `Errore Groq ${res.status}`;
    if (res.status === 401) throw new AIError('Chiave Groq non valida: controlla GROQ_API_KEY su Vercel', 401);
    if (res.status === 429) throw new AIError('Troppe richieste all’AI: attendi 30 secondi e riprova.', 429);
    last = msg;
    if (gone(msg) || res.status === 404) continue;
    if (json && /json/i.test(msg)) { json = false; continue; }
    throw new AIError(msg);
  }
  throw new AIError(`Nessun modello AI disponibile su Groq (${last})`);
}

function extractJson(text) {
  const clean = String(text).replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (e) {}
  const obj = clean.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (e) {} }
  const arr = clean.match(/\[[\s\S]*\]/);
  if (arr) { try { return { recipes: JSON.parse(arr[0]) }; } catch (e) {} }
  return null;
}

function sectionKey(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  for (const [k, v] of Object.entries(SECTIONS)) if (k === n || v.toLowerCase() === n) return k;
  for (const [k, v] of Object.entries(SECTIONS)) if (n.includes(v.toLowerCase()) || v.toLowerCase().includes(n)) return k;
  if (/gelat|sorbett|semifredd|granit/.test(n)) return 'gelateria';
  if (/torta|torte|crostat/.test(n)) return 'torte';
  if (/dining|piatto|dessert al piatto/.test(n)) return 'fine-dining';
  if (/colazion|monoporz|lievitat|viennois/.test(n)) return 'colazioni';
  return '';
}
function category(c) {
  const n = String(c || '').trim().toLowerCase();
  return CATEGORIES.find((x) => x.toLowerCase() === n) || CATEGORIES.find((x) => n && (n.includes(x.toLowerCase()) || x.toLowerCase().includes(n))) || 'Altro';
}
function num(q) {
  if (q === null || q === undefined || q === '') return null;
  const v = typeof q === 'number' ? q : parseFloat(String(q).replace(',', '.'));
  return isFinite(v) ? v : null;
}

// dal formato "ricco" dell'AI al formato dell'app
function toApp(r) {
  if (!r || typeof r !== 'object') return null;
  const n = String(r.name || r.n || '').trim();
  if (!n) return null;
  const ings = (Array.isArray(r.ingredients) ? r.ingredients : Array.isArray(r.i) ? r.i : []).map((x) => {
    if (Array.isArray(x)) return [String(x[0] || '').trim(), num(x[1]), String(x[2] || 'g').trim() || 'g'];
    const name = String(x && x.name || '').trim() + (x && x.note ? ` (${String(x.note).trim()})` : '');
    return [name, num(x && x.quantity), String(x && x.unit || 'g').trim() || 'g'];
  }).filter((x) => x[0]);
  const steps = (Array.isArray(r.steps) ? r.steps : []).map((s, i) => {
    if (typeof s === 'string') return `${i + 1}. ${s.trim()}`;
    const extra = [s && s.temperature ? String(s.temperature).trim() : '', s && s.duration_min ? `${s.duration_min} min` : ''].filter(Boolean).join(' · ');
    return `${i + 1}. ${String(s && s.body || '').trim()}${extra ? ` (${extra})` : ''}`;
  }).filter((x) => x.length > 3);
  const parts = [];
  if (r.yield_note) parts.push(`Resa: ${String(r.yield_note).trim()}`);
  if (steps.length) parts.push(steps.join('\n'));
  else if (r.p) parts.push(String(r.p).trim());
  if (r.notes) parts.push(`Note: ${String(r.notes).trim()}`);
  const out = { n, c: category(r.category || r.c), s: sectionKey(r.section || r.s), i: ings };
  const piatto = String(r.dish_group || r.piatto || '').trim();
  if (piatto && piatto.toLowerCase() !== n.toLowerCase()) out.piatto = piatto;
  if (parts.length) out.p = parts.join('\n\n');
  return out;
}

function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    const extra = String(process.env.IMPORT_ALLOWED_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean);
    return host === req.headers.host || extra.includes(host) || /^localhost(:\d+)?$/.test(host);
  } catch (e) { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ ok: true, configured: !!process.env.GROQ_API_KEY });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo non consentito' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Richiesta non autorizzata' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Richiesta non valida' });
  const image = body.image ? String(body.image) : '';
  const text = body.text ? String(body.text) : '';
  if (image && !/^data:image\/(jpeg|png|webp);base64,/.test(image)) return res.status(400).json({ error: 'Formato immagine non supportato' });
  if (!image && !text.trim()) return res.status(400).json({ error: 'Nessun contenuto da analizzare' });

  try {
    const out = image
      ? await groqChat({ system: prompt(), user: 'Estrai le ricette da questa immagine e rispondi solo con il JSON.', image, json: true })
      : await groqChat({ system: prompt(), user: text.slice(0, 24000), json: true });
    const parsed = extractJson(out);
    const raw = Array.isArray(parsed && parsed.recipes) ? parsed.recipes : Array.isArray(parsed) ? parsed : parsed && (parsed.name || parsed.n) ? [parsed] : [];
    return res.status(200).json({ recipes: raw.map(toApp).filter(Boolean) });
  } catch (e) {
    return res.status(e instanceof AIError ? e.status : 500).json({ error: e.message || 'Errore AI' });
  }
};
