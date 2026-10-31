// Tiene sveglio il database Supabase (il piano gratuito va in pausa dopo 7 giorni senza attività).
// Vercel lo chiama ogni giorno da solo (vedi "crons" in vercel.json); si può aprire anche a mano:
//   https://pastry-recipe.vercel.app/api/keepalive
// Fa una piccola lettura su ogni tabella: è un'attività reale sul database, non cambia nessun dato.
const SB_URL = process.env.SUPABASE_URL || 'https://tedjmlbpojdohtawepvr.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlZGptbGJwb2pkb2h0YXdlcHZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNjY1OTMsImV4cCI6MjA5Mjc0MjU5M30.5aelZWmJOqbkKekQPUmY2RL-EcH__T1uT1d3q_7C4JI';
const TABLES = ['ricette', 'library_books'];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret && req.query && req.query.key !== secret) {
    return res.status(401).json({ ok: false, error: 'Non autorizzato' });
  }
  const out = { ok: false, at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/' + t + '?select=id&limit=1', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
      out.tables[t] = r.status;
      if (r.ok) out.ok = true;
    } catch (e) {
      out.tables[t] = 'errore: ' + (e && e.message || e);
    }
  }
  return res.status(out.ok ? 200 : 502).json(out);
};
