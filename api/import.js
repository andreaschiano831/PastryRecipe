// Inserimento ricette con AI dal server (come in ANDRE-S-RECIPE):
// la chiave Groq resta su Vercel (variabile GROQ_API_KEY).
// GET  /api/import            -> { ok, configured }
// POST /api/import  { image } -> { recipes, source }   (una foto, data URL jpeg/png/webp)
// POST /api/import  { text }  -> { recipes }
//
// Le foto si analizzano in DUE passaggi per evitare dati inventati:
//   1) il modello visivo TRASCRIVE il testo della foto così com'è (OCR, niente interpretazioni)
//   2) un modello di testo trasforma la trascrizione in ricette, usando solo ciò che c'è scritto
//   3) ogni quantità viene confrontata con la trascrizione: quelle non trovate vengono segnalate
// Il blocco CORE è identico a quello usato nell'app quando la chiave è sul telefono.

/* ===== CORE-START ===== */
var AI_VISION = ['qwen/qwen3.8-27b', 'meta-models/muse-spark-open', 'meta-llama/llama-4-scout-17b-16e-instruct'];
var AI_TEXT = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
var AI_SECTIONS = { colazioni: 'Monoporzioni', 'fine-dining': 'Fine Dining', gelateria: 'Gelateria', torte: 'Torte' };
var AI_CATEGORIES = ['Creme', 'Paste', 'Torte', 'Lievitati', 'Pasticcini', 'Marmellate', 'Ganache', 'Mousse', 'Gelatine', 'Gelati', 'Sorbetti', 'Semifreddi', 'Granite', 'Basi', 'Glasse', 'Biscotti', 'Altro'];

var AI_OCR_PROMPT = 'Sei un sistema OCR di precisione. Trascrivi ESATTAMENTE tutto il testo visibile nell\'immagine, riga per riga, nello stesso ordine.\n' +
  'REGOLE:\n' +
  '- Copia numeri, virgole, punti e unità ESATTAMENTE come sono scritti (es. "450", "1,5", "70 g", "gr 200"). Non arrotondare e non convertire.\n' +
  '- Non tradurre, non correggere, non riassumere, non completare ricette, non aggiungere ingredienti o passaggi che non vedi.\n' +
  '- Mantieni le righe di una tabella sulla stessa riga separando le colonne con " | ".\n' +
  '- Se una parola o un numero non è leggibile scrivi [?] al suo posto: non indovinare.\n' +
  '- Ignora tutto ciò che non è testo (sfondi, riflessi, oggetti).\n' +
  '- Rispondi SOLO con la trascrizione, senza commenti. Se nell\'immagine non c\'è testo leggibile rispondi esattamente: NESSUN TESTO';

function aiRecipePrompt() {
  var secs = Object.keys(AI_SECTIONS).map(function (k) { return '"' + AI_SECTIONS[k] + '"'; }).join(', ');
  return 'Sei l\'assistente di un pastry chef stellato. Ricevi un testo (spesso la trascrizione di una foto) e ne estrai le ricette. Restituisci SOLO un oggetto JSON, senza testo fuori dal JSON, in questo formato:\n' +
    '{"recipes":[{"name":"","section":"","category":"","dish_group":"","yield_note":"","ingredients":[{"name":"","quantity":0,"unit":"g","note":""}],"steps":[{"body":"","duration_min":null,"temperature":""}],"notes":""}]}\n' +
    'REGOLE ASSOLUTE:\n' +
    '1. Usa SOLO informazioni presenti nel testo. NON inventare ingredienti, quantità, passaggi, tempi o temperature. Se una quantità non è scritta o è [?], metti "quantity": null.\n' +
    '2. Ogni quantità deve essere IDENTICA al numero scritto nel testo (usa il punto come decimale: "1,5" diventa 1.5). Non convertire unità, non ricalcolare, non arrotondare.\n' +
    '3. Ogni preparazione con un proprio titolo (es. "Massa macaron", "Cremoso pesca", "Glassa") è una ricetta SEPARATA. Se fanno parte dello stesso dolce, metti il nome del dolce in "dish_group". Se il testo non ha un titolo, dai un nome breve e descrittivo basato sugli ingredienti principali.\n' +
    '4. Unità: g, kg, ml, l, cl, n°, q.b., foglio, bacca, %. "gr" diventa "g"; uova/tuorli contati diventano "n°". Se il numero non ha unità ma il contesto è una ricetta in grammi, usa "g".\n' +
    '5. Nomi degli ingredienti in italiano professionale (traduci solo se il testo è in un\'altra lingua; mantieni marchi e nomi propri, es. "Ivoire", "Petra").\n' +
    '6. "steps": un passaggio per azione, nell\'ordine del testo. Riporta minuti in "duration_min" e temperature in "temperature" SOLO se scritti.\n' +
    '7. "section": scegli tra ' + secs + '. "category" deve essere una di: ' + AI_CATEGORIES.join(', ') + '.\n' +
    '8. "yield_note": la resa solo se scritta, altrimenti "". "notes": solo note presenti nel testo, altrimenti "".\n' +
    '9. Ignora testo che non fa parte di una ricetta (pubblicità, menu, commenti).';
}

function aiStripThink(t) { return String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim(); }
function aiGone(m) { return /does not exist|decommissioned|deprecated|not found|do not have access|model_not_found|not supported/i.test(m); }

function aiExtractJson(text) {
  var clean = String(text).replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (e) {}
  var obj = clean.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (e) {} }
  var arr = clean.match(/\[[\s\S]*\]/);
  if (arr) { try { return { recipes: JSON.parse(arr[0]) }; } catch (e) {} }
  return null;
}
function aiSectionKey(name) {
  var n = String(name || '').trim().toLowerCase(), k;
  if (!n) return '';
  for (k in AI_SECTIONS) if (k === n || AI_SECTIONS[k].toLowerCase() === n) return k;
  for (k in AI_SECTIONS) { var v = AI_SECTIONS[k].toLowerCase(); if (n.indexOf(v) > -1 || v.indexOf(n) > -1) return k; }
  if (/gelat|sorbett|semifredd|granit/.test(n)) return 'gelateria';
  if (/torta|torte|crostat/.test(n)) return 'torte';
  if (/dining|piatto/.test(n)) return 'fine-dining';
  if (/colazion|monoporz|lievitat|viennois/.test(n)) return 'colazioni';
  return '';
}
function aiCategory(c) {
  var n = String(c || '').trim().toLowerCase();
  return AI_CATEGORIES.filter(function (x) { return x.toLowerCase() === n; })[0] ||
    AI_CATEGORIES.filter(function (x) { return n && (n.indexOf(x.toLowerCase()) > -1 || x.toLowerCase().indexOf(n) > -1); })[0] || 'Altro';
}
function aiNum(q) {
  if (q === null || q === undefined || q === '') return null;
  var v = typeof q === 'number' ? q : parseFloat(String(q).replace(',', '.'));
  return isFinite(v) ? v : null;
}
// numeri presenti nella trascrizione (gestisce 1,5 / 1.5 / 1.000)
function aiNumbersIn(text) {
  var set = {}, m, re = /\d+(?:[.,]\d+)*/g;
  while ((m = re.exec(String(text || ''))) !== null) {
    var s = m[0];
    set[parseFloat(s.replace(',', '.'))] = 1;
    set[parseFloat(s.replace(/\./g, '').replace(',', '.'))] = 1;
    set[parseFloat(s.replace(/,/g, ''))] = 1;
  }
  return set;
}

// dal formato "ricco" dell'AI al formato dell'app; se c'è la trascrizione, controlla le quantità
function aiToApp(r, source) {
  if (!r || typeof r !== 'object') return null;
  var n = String(r.name || r.n || '').trim();
  if (!n) return null;
  var nums = source ? aiNumbersIn(source) : null, warn = [];
  var ings = (Array.isArray(r.ingredients) ? r.ingredients : Array.isArray(r.i) ? r.i : []).map(function (x) {
    var row;
    if (Array.isArray(x)) row = [String(x[0] || '').trim(), aiNum(x[1]), String(x[2] || 'g').trim() || 'g'];
    else row = [String((x && x.name) || '').trim() + (x && x.note ? ' (' + String(x.note).trim() + ')' : ''), aiNum(x && x.quantity), String((x && x.unit) || 'g').trim() || 'g'];
    if (nums && row[0] && row[1] !== null && !nums[row[1]]) warn.push(row[0] + ' ' + row[1] + ' ' + row[2]);
    return row;
  }).filter(function (x) { return x[0]; });
  var steps = (Array.isArray(r.steps) ? r.steps : []).map(function (s, i) {
    if (typeof s === 'string') return (i + 1) + '. ' + s.trim();
    var extra = [s && s.temperature ? String(s.temperature).trim() : '', s && s.duration_min ? s.duration_min + ' min' : ''].filter(Boolean).join(' · ');
    return (i + 1) + '. ' + String((s && s.body) || '').trim() + (extra ? ' (' + extra + ')' : '');
  }).filter(function (x) { return x.length > 3; });
  var parts = [];
  if (r.yield_note) parts.push('Resa: ' + String(r.yield_note).trim());
  if (steps.length) parts.push(steps.join('\n'));
  else if (r.p) parts.push(String(r.p).trim());
  if (r.notes) parts.push('Note: ' + String(r.notes).trim());
  var out = { n: n, c: aiCategory(r.category || r.c), s: aiSectionKey(r.section || r.s), i: ings };
  var piatto = String(r.dish_group || r.piatto || '').trim();
  if (piatto && piatto.toLowerCase() !== n.toLowerCase()) out.piatto = piatto;
  if (parts.length) out.p = parts.join('\n\n');
  if (warn.length) out._warn = warn;
  return out;
}

// chat(kind, system, user, image, json) -> Promise<{text}|{error,_status}>
async function aiExtract(chat, payload) {
  var source = '';
  if (payload.image) {
    var o = await chat('vision', AI_OCR_PROMPT, 'Trascrivi il testo di questa immagine.', payload.image, false);
    if (o.error) return o;
    source = aiStripThink(o.text).replace(/^```[a-z]*\n?|```$/g, '').trim();
    if (!source || /^NESSUN TESTO/i.test(source) || source.replace(/\[\?\]|\s/g, '').length < 8) {
      return { error: 'Non riesco a leggere il testo della foto. Prova con una foto più vicina, dritta e ben illuminata.', _status: 422, source: source };
    }
  } else {
    source = String(payload.text || '').slice(0, 24000);
  }
  var r = await chat('text', aiRecipePrompt(), source, null, true);
  if (r.error) return r;
  var parsed = aiExtractJson(r.text);
  var raw = Array.isArray(parsed && parsed.recipes) ? parsed.recipes : Array.isArray(parsed) ? parsed : parsed && (parsed.name || parsed.n) ? [parsed] : [];
  var recipes = raw.map(function (x) { return aiToApp(x, payload.image ? source : ''); }).filter(Boolean);
  return payload.image ? { recipes: recipes, source: source } : { recipes: recipes };
}

// chiamata Groq con modelli di riserva
async function aiGroqChat(url, key, kind, system, user, image, json) {
  var models = kind === 'vision' ? AI_VISION : AI_TEXT, last = '';
  for (var mi = 0; mi < models.length; mi++) {
    var model = models[mi];
    var content = image ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: image } }] : user;
    var body = { model: model, temperature: 0, max_completion_tokens: 8000, messages: [{ role: 'system', content: system }, { role: 'user', content: content }] };
    if (json) body.response_format = { type: 'json_object' };
    if (model.indexOf('openai/gpt-oss') === 0) body.reasoning_effort = kind === 'vision' ? 'low' : 'medium';
    else if (model.indexOf('qwen/') === 0) body.reasoning_effort = 'none';
    var send = function (b) { return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(b) }); };
    var res = await send(body);
    var data = await res.json().catch(function () { return null; });
    var em = (data && data.error && data.error.message) || '';
    if (!res.ok && res.status === 400 && body.reasoning_effort && /reasoning/i.test(em)) {
      delete body.reasoning_effort; res = await send(body); data = await res.json().catch(function () { return null; }); em = (data && data.error && data.error.message) || '';
    }
    var out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (res.ok && out) return { text: aiStripThink(out) };
    var msg = em || ('Errore Groq ' + res.status);
    if (res.status === 401) return { error: 'Chiave Groq non valida', _status: 401 };
    if (res.status === 429) return { error: 'Troppe richieste all’AI: attendi 30 secondi e riprova.', _status: 429 };
    last = msg;
    if (aiGone(msg) || res.status === 404) continue;
    if (json && /json|response_format/i.test(msg)) { json = false; delete body.response_format; mi--; continue; }
    return { error: msg, _status: res.status || 502 };
  }
  return { error: 'Nessun modello AI disponibile su Groq (' + last + ')', _status: 502 };
}
/* ===== CORE-END ===== */

const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
if (process.env.GROQ_VISION_MODEL) AI_VISION.unshift(process.env.GROQ_VISION_MODEL);
if (process.env.GROQ_TEXT_MODEL) AI_TEXT.unshift(process.env.GROQ_TEXT_MODEL);

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
  if (req.method === 'GET') return res.status(200).json({ ok: true, configured: !!process.env.GROQ_API_KEY, version: 2 });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo non consentito' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Richiesta non autorizzata' });
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(503).json({ error: 'GROQ_API_KEY non configurata su Vercel' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Richiesta non valida' });
  const image = body.image ? String(body.image) : '';
  const text = body.text ? String(body.text) : '';
  if (image && !/^data:image\/(jpeg|png|webp);base64,/.test(image)) return res.status(400).json({ error: 'Formato immagine non supportato' });
  if (!image && !text.trim()) return res.status(400).json({ error: 'Nessun contenuto da analizzare' });

  try {
    const chat = (kind, system, user, img, json) => aiGroqChat(GROQ_URL, key, kind, system, user, img, json);
    const out = await aiExtract(chat, image ? { image } : { text });
    if (out.error) return res.status(out._status && out._status >= 400 ? out._status : 502).json({ error: out.error, source: out.source });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Errore AI' });
  }
};
