const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const PORT  = process.env.PORT || 3001;

// ── Env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* .env optional */ }
}
loadEnv();

// ── Anthropic SDK ─────────────────────────────────────────────────────────────

let Anthropic = null;
try { const m = require('@anthropic-ai/sdk'); Anthropic = m.default ?? m; } catch { /* npm install */ }

// ── Supabase admin client (lazy) ──────────────────────────────────────────────

let _supabaseAdmin = null;
function getSupabaseAdmin() {
  if (_supabaseAdmin) return _supabaseAdmin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  _supabaseAdmin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _supabaseAdmin;
}

async function getUserFromRequest(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data: { user } } = await admin.auth.getUser(auth.slice(7));
  return user || null;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const DATA_DIR      = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── ElevenLabs API ────────────────────────────────────────────────────────────

function elGet(urlPath) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return Promise.reject(new Error('ELEVENLABS_API_KEY not set'));
  return new Promise((resolve, reject) => {
    https.get(
      { hostname: 'api.elevenlabs.io', path: urlPath, headers: { 'xi-api-key': apiKey } },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode >= 400) { reject(new Error(`ElevenLabs ${res.statusCode}: ${body}`)); return; }
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    ).on('error', reject);
  });
}

function elPost(urlPath, payload) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return Promise.reject(new Error('ELEVENLABS_API_KEY not set'));
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path: urlPath,
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 400) { reject(new Error(`ElevenLabs ${res.statusCode}: ${data}`)); return; }
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function elTTS(voiceId, text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return Promise.reject(new Error('ELEVENLABS_API_KEY not set'));
  const body = JSON.stringify({ text, model_id: 'eleven_multilingual_v2' });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path:     `/v1/text-to-speech/${voiceId}`,
      method:   'POST',
      headers:  { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode >= 400) {
        let e = ''; res.on('data', c => e += c); res.on('end', () => reject(new Error(`ElevenLabs TTS ${res.statusCode}: ${e}`))); return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getConversation(conversationId, agentId) {
  if (!conversationId) {
    if (!agentId) agentId = process.env.ELEVENLABS_AGENT_ID_FRENCH || process.env.ELEVENLABS_AGENT_ID;
    if (!agentId) throw new Error('No agent ID configured');
    await sleep(2000);
    const list = await elGet(`/v1/convai/conversations?agent_id=${agentId}&page_size=1`);
    const convs = list.conversations ?? list;
    if (!convs?.length) throw new Error('No conversations found');
    conversationId = convs[0].conversation_id;
  }
  for (let i = 0; i < 8; i++) {
    const conv = await elGet(`/v1/convai/conversations/${conversationId}`);
    if (conv.status === 'done') return conv;
    if (conv.status === 'failed') throw new Error('Conversation processing failed');
    await sleep(3000);
  }
  throw new Error('Transcript not ready after 24s — try again in a moment');
}

// ── Claude error analysis ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert language teacher reviewing a transcript of a language learning conversation. Identify every error made by the LEARNER (labeled "LEARNER:") — never flag the tutor's speech.

Identify errors in exactly these five categories:
- grammar: General grammatical mistakes
- verb_conjugation: Wrong tense, mood, person, or number
- gender_agreement: Wrong article, adjective, or pronoun gender agreement
- word_choice: Incorrect word, false cognate, or vocabulary error
- awkward_phrasing: Grammatically acceptable but unnatural

For each error provide:
- category: one of the five above
- severity: "low", "medium", or "high"
- learnerSaid: the exact erroneous phrase
- correction: the corrected version
- explanation: one concise sentence

Return ONLY a JSON code block — no prose before or after:
\`\`\`json
{"errors":[{"category":"...","severity":"...","learnerSaid":"...","correction":"...","explanation":"..."}]}
\`\`\`
If no errors, return \`\`\`json\n{"errors":[]}\n\`\`\`. Maximum 10 errors.`;

async function analyzeTranscript(transcript) {
  if (!Anthropic) throw new Error('Missing dependency — run: npm install');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const turns = (transcript || [])
    .filter(t => t.message)
    .map(t => `${t.role === 'user' ? 'LEARNER' : 'TUTOR'}: ${t.message}`)
    .join('\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Transcript:\n\n${turns}` }],
  });

  const text = msg.content[0].text;
  let parsed;
  try {
    const block = text.match(/```json\s*([\s\S]*?)```/);
    const bare  = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse((block ? block[1] : bare ? bare[0] : '{}').trim());
  } catch { parsed = { errors: [] }; }
  return Array.isArray(parsed.errors) ? parsed.errors : [];
}

// ── Claude session metrics (clean-turn streak, CEFR-lite score, ledger facts) ─

const METRICS_PROMPT = `You are extracting quantitative metrics from a language learning transcript. Be conservative and precise. Base all judgments only on what appears in the transcript.

Definitions:
- A LEARNER TURN is any turn labeled "LEARNER:" that contains a substantive response (not just "yes", "no", "ok", "hmm", or a single filler word).
- A CLEAN TURN is a LEARNER TURN where ALL of the following are true:
  (a) The learner used ≤1 English word in their response (proper nouns, names, and numbers don't count as English).
  (b) The learner's response is grammatically intelligible — it may have errors but the meaning is recoverable.
  If either condition fails, the turn is NOT clean.

Return ONLY a JSON code block:
\`\`\`json
{"cleanTurnStreak": N, "cefrScore": X.X, "facts": [...]}
\`\`\`

cleanTurnStreak (integer): The LONGEST consecutive sequence of CLEAN TURNS. If no such sequence of 2 or more exists, output 0. A single clean turn alone = 1. When in doubt whether a turn qualifies, don't count it.

cefrScore (float, 1.0–6.0): The learner's demonstrated proficiency for this session based on vocabulary range, error frequency and severity, sentence complexity, spontaneity, and ability to maintain conversational flow.
  1.0–1.9 = A1 (extreme beginner, isolated words only)
  2.0–2.9 = A2 (simple phrases, highly formulaic)
  3.0–3.9 = B1 (manages everyday situations, noticeable errors)
  4.0–4.9 = B2 (fluent on familiar topics, mostly correct)
  5.0–5.9 = C1 (precise, complex expression, minor slips only)
  6.0 = C2 (near-native precision)

facts (array, max 3): Concrete, low-key factual details the learner EXPLICITLY stated. Include ONLY:
  - Stated occupation or profession
  - Specific upcoming concrete plans (travel, events — not vague future wishes)
  - A specific grammar error pattern that appeared 2 or more times this session
  - An explicitly stated preference (food, sport, hobby, topic)
NEVER include: feelings, emotions, personal struggles, learning difficulties, or any introspective/diary-like content.
Each fact: {"text": "...", "type": "occupation|plan|error_pattern|preference"}
Return [] if nothing qualifies.`;

async function analyzeSessionMetrics(transcript) {
  if (!Anthropic) throw new Error('Missing dependency — run: npm install');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const turns = (transcript || [])
    .filter(t => t.message)
    .map(t => `${t.role === 'user' ? 'LEARNER' : 'TUTOR'}: ${t.message}`)
    .join('\n');

  if (!turns) return { cleanTurnStreak: 0, cefrScore: null, facts: [] };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [{ type: 'text', text: METRICS_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Transcript:\n\n${turns}` }],
  });

  const text = msg.content[0].text;
  let parsed;
  try {
    const block = text.match(/```json\s*([\s\S]*?)```/);
    const bare  = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse((block ? block[1] : bare ? bare[0] : '{}').trim());
  } catch { parsed = {}; }

  return {
    cleanTurnStreak: Number.isInteger(parsed.cleanTurnStreak) ? Math.max(0, parsed.cleanTurnStreak) : 0,
    cefrScore:       (typeof parsed.cefrScore === 'number' && parsed.cefrScore >= 1 && parsed.cefrScore <= 6)
                       ? Math.round(parsed.cefrScore * 100) / 100 : null,
    facts:           Array.isArray(parsed.facts) ? parsed.facts.filter(f => f && f.text && f.type).slice(0, 3) : [],
  };
}

// ── Semantic clustering for grammar/conjugation/agreement/phrasing patterns ───
// Groups corrections that represent the same underlying rule (e.g., same wrong
// tense in different sentences) so they surface as one pattern, not many.
// word_choice is excluded — its learnerSaid→correction key already clusters well.

async function clusterPatternsBySemantic(patternMap) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return patternMap;
  const entries = Object.entries(patternMap).filter(([, p]) => p.category !== 'word_choice');
  if (entries.length < 2) return patternMap;

  const items = entries.map(([key, p], i) => ({ idx: i, key, category: p.category, correction: p.correction }));
  const byCat = {};
  for (const it of items) (byCat[it.category] = byCat[it.category] || []).push(it);

  const catBlocks = Object.entries(byCat)
    .map(([cat, its]) => `${cat}:\n${its.map(it => `  [${it.idx}] "${it.correction}"`).join('\n')}`)
    .join('\n\n');

  const prompt = `Group these language-learning corrections by their underlying grammar rule. Corrections that reflect the SAME mistake in different sentences belong in the same group.

${catBlocks}

Return ONLY a JSON code block:
\`\`\`json
{"groups":[[0,2],[1],[3,4]]}
\`\`\`
Every index must appear in exactly one group. Only group within the same category — never across. When in doubt, keep separate (singleton group). Groups of 1 are fine.`;

  let groups;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
    const text  = msg.content[0].text;
    const block = text.match(/```json\s*([\s\S]*?)```/);
    const bare  = text.match(/\{[\s\S]*\}/);
    groups = JSON.parse((block ? block[1] : bare ? bare[0] : '{}').trim()).groups;
  } catch (e) {
    console.error('[Cluster]', e.message);
    return patternMap;
  }
  if (!Array.isArray(groups)) return patternMap;

  const result = {};
  // Keep word_choice patterns unchanged
  for (const [key, p] of Object.entries(patternMap)) {
    if (p.category === 'word_choice') result[key] = p;
  }
  // Merge grammar/etc patterns by Claude's grouping
  for (let gi = 0; gi < groups.length; gi++) {
    const idxs = groups[gi];
    if (!Array.isArray(idxs) || !idxs.length) continue;
    const members = idxs.map(i => items[i]).filter(Boolean);
    if (!members.length) continue;

    const mergedSessions = new Set();
    let mergedCount = 0;
    let repKey = members[0].key;

    for (const m of members) {
      const orig = patternMap[m.key];
      if (!orig) continue;
      for (const s of orig.sessions) mergedSessions.add(s);
      mergedCount += orig.count;
      const cur = patternMap[repKey];
      if (orig.sessions.size > cur.sessions.size ||
          (orig.sessions.size === cur.sessions.size && orig.count > cur.count)) {
        repKey = m.key;
      }
    }

    const rep = patternMap[repKey];
    if (!rep) continue;
    result['cluster_' + gi] = {
      category:    rep.category,
      learnerSaid: rep.learnerSaid,
      correction:  rep.correction,
      explanation: rep.explanation,
      sessions:    mergedSessions,
      count:       mergedCount,
    };
  }
  return result;
}

// ── CEFR-lite tier logic ──────────────────────────────────────────────────────

const CEFR_TIER_DATA = [
  { maxScore: 2.0, tier: 'A1', label: 'Just getting started' },
  { maxScore: 3.0, tier: 'A2', label: 'Handling the basics' },
  { maxScore: 4.0, tier: 'B1', label: 'Getting by in everyday life' },
  { maxScore: 5.0, tier: 'B2', label: 'Holding a real conversation' },
  { maxScore: 6.0, tier: 'C1', label: 'Expressing yourself freely' },
  { maxScore: 7.0, tier: 'C2', label: 'Thinking in the language' },
];
const TIER_ORDER         = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
const CALIBRATION_SESSIONS = 3; // sessions 1–N are calibration-only; tier kicks in from N+1

function scoreToCefrTier(score) {
  for (const t of CEFR_TIER_DATA) {
    if (score < t.maxScore) return { tier: t.tier, label: t.label };
  }
  return { tier: 'C2', label: 'Thinking in the language' };
}

function weightedCefrAverage(scores) {
  let wSum = 0, wTotal = 0;
  for (let i = 0; i < scores.length; i++) {
    const w = i + 1; // older scores get lower weight
    wSum   += w;
    wTotal += scores[i] * w;
  }
  return wTotal / wSum;
}

// ── Persona progress update + milestone detection ──────────────────────────────

async function updatePersonaProgress(userId, persona, sessionId, cefrScore, cleanTurnStreak, facts, supabase) {
  const { data: progress } = await supabase
    .from('persona_progress')
    .select('*')
    .eq('user_id', userId)
    .eq('persona', persona)
    .maybeSingle();

  const sessionCount = (progress?.session_count ?? 0) + 1;
  const prevAlltime  = progress?.longest_clean_turn_streak_alltime ?? 0;
  const newAlltime   = Math.max(prevAlltime, cleanTurnStreak);

  const recentScores = Array.isArray(progress?.recent_cefr_scores) ? [...progress.recent_cefr_scores] : [];
  if (cefrScore !== null) {
    recentScores.push(cefrScore);
    if (recentScores.length > 5) recentScores.shift();
  }

  const milestones = [];

  if (cleanTurnStreak > prevAlltime && cleanTurnStreak > 0) {
    milestones.push({ type: 'streak', value: cleanTurnStreak });
  }

  let newTier = null, newTierLabel = null;
  if (sessionCount > CALIBRATION_SESSIONS && recentScores.length > 0) {
    const avg      = weightedCefrAverage(recentScores);
    const tierInfo = scoreToCefrTier(avg);
    newTier      = tierInfo.tier;
    newTierLabel = tierInfo.label;

    const prevTier = progress?.cefr_tier ?? null;
    if (!prevTier || (TIER_ORDER[newTier] ?? 0) > (TIER_ORDER[prevTier] ?? 0)) {
      milestones.push({ type: 'tier', tier: newTier, label: newTierLabel, fact: facts[0]?.text ?? null });
    }
  }

  await supabase.from('persona_progress').upsert({
    user_id:                           userId,
    persona,
    session_count:                     sessionCount,
    longest_clean_turn_streak_alltime: newAlltime,
    cefr_tier:                         newTier        ?? (progress?.cefr_tier        ?? null),
    cefr_tier_label:                   newTierLabel   ?? (progress?.cefr_tier_label  ?? null),
    recent_cefr_scores:                recentScores,
  }, { onConflict: 'user_id,persona' });

  if (facts.length > 0) {
    await supabase.from('persona_facts').insert(
      facts.map(f => ({ user_id: userId, persona, session_id: sessionId, fact: f.text, fact_type: f.type }))
    ).catch(e => console.error('[Supabase] Facts insert:', e.message));
  }

  return milestones;
}

// ── Write session to Supabase (with sessions.json fallback) ────────────────────

async function writeSessionAndUpdateProgress(session, metrics, userId, supabase) {
  const { error: sessErr } = await supabase.from('sessions').insert({
    id:                session.id,
    user_id:           userId,
    conversation_id:   session.conversationId,
    created_at:        session.createdAt,
    duration_secs:     session.durationSecs,
    persona:           session.persona,
    clean_turn_streak: metrics.cleanTurnStreak,
    cefr_score:        metrics.cefrScore,
  });

  if (sessErr) {
    console.error('[Supabase] Session insert failed:', sessErr.message, '— falling back to sessions.json');
    const sessions = readJSON(SESSIONS_FILE, []);
    sessions.unshift(session);
    writeJSON(SESSIONS_FILE, sessions);
    return [];
  }

  if (session.errors.length > 0) {
    const { error: errErr } = await supabase.from('session_errors').insert(
      session.errors.map(e => ({
        id:           e.id,
        session_id:   session.id,
        user_id:      userId,
        category:     e.category,
        severity:     e.severity,
        learner_said: e.learnerSaid,
        correction:   e.correction,
        explanation:  e.explanation,
        status:       e.status || 'open',
      }))
    );
    if (errErr) console.error('[Supabase] Errors insert:', errErr.message);
  }

  return updatePersonaProgress(
    userId, session.persona, session.id,
    metrics.cefrScore, metrics.cleanTurnStreak, metrics.facts ?? [],
    supabase
  ).catch(e => { console.error('[Supabase] Progress update:', e.message); return []; });
}

// ── Level prompt builder (server-side, mirrors client logic) ─────────────────

const ADAPTIVE_BLOCK = '\n\nADAPTIVE CALIBRATION — strictly internal, never reference or hint at this to the learner: Throughout the conversation, silently track the learner\'s demonstrated skill level by monitoring error frequency, response fluency, sentence complexity, and vocabulary range. Continuously adjust your own vocabulary complexity, sentence length, and pacing in real time to stay just slightly above the learner\'s demonstrated ability. Never announce, acknowledge, or hint at these adjustments — keep the calibration entirely invisible.';

function buildLevelPrompt(level) {
  const n = Math.min(10, Math.max(1, parseInt(level, 10) || 5));
  let levelPrompt;
  if (n <= 2)      levelPrompt = `The learner rates their proficiency ${n}/10 — a complete beginner. Use only the most basic, high-frequency vocabulary. Keep every sentence very short and simple. Speak slowly and clearly. Focus exclusively on present tense and essential everyday expressions. Avoid all idioms and complex structures.`;
  else if (n <= 4) levelPrompt = `The learner rates their proficiency ${n}/10 — elementary level. Use simple vocabulary and straightforward sentence structures. Stick to common grammar patterns and basic tenses. Avoid idioms and complex syntax. Speak at a deliberate, clear pace.`;
  else if (n <= 6) levelPrompt = `The learner rates their proficiency ${n}/10 — intermediate level. Use a moderate vocabulary range and varied sentence structures. Introduce common everyday idioms naturally. Maintain a natural conversational pace, slowing only when the learner shows difficulty.`;
  else if (n <= 8) levelPrompt = `The learner rates their proficiency ${n}/10 — advanced level. Use sophisticated vocabulary, complex sentence structures, and idiomatic expressions freely. Incorporate cultural references and nuanced grammar. Converse at a full, natural pace across a wide range of topics.`;
  else             levelPrompt = `The learner rates their proficiency ${n}/10 — near-native proficiency. Use the full richness of the language: advanced vocabulary, intricate constructions, subtle idioms, cultural nuance, and stylistic variation. Engage them as you would a near-peer speaker.`;
  return `You are a warm, encouraging, and knowledgeable language conversation partner. Your purpose is to help learners build genuine fluency through natural, engaging conversation. Guide learners with care, weaving corrections gracefully into the conversation rather than interrupting with blunt feedback.\n\nSTARTING LEVEL: ${levelPrompt}${ADAPTIVE_BLOCK}`;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

// ── Server ────────────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const url    = req.url.split('?')[0];
  const method = req.method;

  const json = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {
    // GET /api/auth-config  (safe to expose — anon key is public by design)
    if (method === 'GET' && url === '/api/auth-config') {
      return json(200, {
        url:     process.env.SUPABASE_URL      || '',
        anonKey: process.env.SUPABASE_ANON_KEY || '',
      });
    }

    // GET /api/config
    if (method === 'GET' && url === '/api/config') {
      return json(200, {
        agents: {
          french:     process.env.ELEVENLABS_AGENT_ID_FRENCH     || '',
          portuguese: process.env.ELEVENLABS_AGENT_ID_PORTUGUESE || '',
          spanish:    process.env.ELEVENLABS_AGENT_ID_SPANISH    || '',
          japanese:   process.env.ELEVENLABS_AGENT_ID_JAPANESE   || '',
          english:    process.env.ELEVENLABS_AGENT_ID_ENGLISH    || '',
          persian:    process.env.ELEVENLABS_AGENT_ID_PERSIAN    || '',
        },
      });
    }

    // GET /api/signed-url?level=5
    if (method === 'GET' && url === '/api/signed-url') {
      const level   = new URL(req.url, 'http://x').searchParams.get('level') || '5';
      const agentId = process.env.ELEVENLABS_AGENT_ID;
      if (!agentId) return json(500, { error: 'ELEVENLABS_AGENT_ID not set' });
      const result = await elPost(`/v1/convai/conversation/get-signed-url?agent_id=${agentId}`, {
        override_config: { agent: { prompt: { prompt: buildLevelPrompt(level) } } },
      });
      return json(200, { signedUrl: result.signed_url });
    }

    // POST /api/analyze-session
    if (method === 'POST' && url === '/api/analyze-session') {
      const body    = await parseBody(req);
      const persona = body.persona || 'french';
      const PERSONA_AGENTS = {
        french:     process.env.ELEVENLABS_AGENT_ID_FRENCH,
        portuguese: process.env.ELEVENLABS_AGENT_ID_PORTUGUESE,
        spanish:    process.env.ELEVENLABS_AGENT_ID_SPANISH,
        japanese:   process.env.ELEVENLABS_AGENT_ID_JAPANESE,
        english:    process.env.ELEVENLABS_AGENT_ID_ENGLISH,
        persian:    process.env.ELEVENLABS_AGENT_ID_PERSIAN,
      };
      const agentId    = PERSONA_AGENTS[persona] || process.env.ELEVENLABS_AGENT_ID_FRENCH;
      const conv       = await getConversation(body.conversationId || null, agentId);
      const transcript = conv.transcript || [];

      // Run error analysis and session metrics in parallel
      const [errors, metrics] = await Promise.all([
        analyzeTranscript(transcript),
        analyzeSessionMetrics(transcript).catch(e => {
          console.error('[Metrics]', e.message);
          return { cleanTurnStreak: 0, cefrScore: null, facts: [] };
        }),
      ]);

      const session = {
        id:               `sess_${Date.now()}`,
        conversationId:   conv.conversation_id,
        createdAt:        new Date().toISOString(),
        durationSecs:     Math.round(conv.metadata?.call_duration_secs ?? 0),
        persona,
        errors:           errors.map((e, i) => ({ ...e, id: `err_${i}`, status: 'open' })),
        cleanTurnStreak:  metrics.cleanTurnStreak,
      };

      const user = await getUserFromRequest(req);
      if (user) {
        session.userId = user.id;
        const supabase = getSupabaseAdmin();
        if (supabase) {
          session.milestones = await writeSessionAndUpdateProgress(session, metrics, user.id, supabase);
        } else {
          // No Supabase configured — fall back to local file
          const sessions = readJSON(SESSIONS_FILE, []);
          sessions.unshift(session);
          writeJSON(SESSIONS_FILE, sessions);
          session.milestones = [];
        }
      } else {
        session.milestones = [];
      }

      return json(200, session);
    }

    // GET /api/sessions-list
    if (method === 'GET' && url === '/api/sessions-list') {
      const user = await getUserFromRequest(req);
      if (!user) return json(401, { error: 'Unauthorized' });
      const supabase = getSupabaseAdmin();
      if (!supabase) return json(500, { error: 'Supabase not configured' });
      const { data: rows } = await supabase
        .from('sessions')
        .select('id, created_at, persona, duration_secs, session_errors(id)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      return json(200, (rows || []).map(s => ({
        id:           s.id,
        createdAt:    s.created_at,
        persona:      s.persona,
        durationSecs: s.duration_secs,
        errorCount:   (s.session_errors || []).length,
      })));
    }

    // GET /api/struggle-patterns?persona=&from=&to=
    if (method === 'GET' && url.startsWith('/api/struggle-patterns')) {
      const user = await getUserFromRequest(req);
      if (!user) return json(401, { error: 'Unauthorized' });
      const supabase = getSupabaseAdmin();
      if (!supabase) return json(500, { error: 'Supabase not configured' });

      const params  = new URL(req.url, 'http://x').searchParams;
      const persona = params.get('persona') || null;
      const from    = params.get('from')    || null;
      const to      = params.get('to')      || null;

      let sessQ = supabase.from('sessions').select('id').eq('user_id', user.id);
      if (persona) sessQ = sessQ.eq('persona', persona);
      if (from)    sessQ = sessQ.gte('created_at', from);
      if (to)      sessQ = sessQ.lte('created_at', to);
      const { data: filteredSessions } = await sessQ;

      if (!filteredSessions?.length) return json(200, { totalErrors: 0, categories: [], patterns: [] });

      const sessionIds = filteredSessions.map(s => s.id);
      const { data: errors } = await supabase
        .from('session_errors')
        .select('id, session_id, category, severity, learner_said, correction, explanation')
        .in('session_id', sessionIds);

      if (!errors?.length) return json(200, { totalErrors: 0, categories: [], patterns: [] });

      // Level 1: category breakdown
      const catCounts = {};
      for (const e of errors) catCounts[e.category] = (catCounts[e.category] || 0) + 1;
      const total      = errors.length;
      const categories = Object.entries(catCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, count]) => ({ category: cat, count, pct: Math.round(count / total * 100) }));

      // Level 2: recurring pattern detection
      // Key: category + normalized correction (for word_choice also include learner_said,
      // since the same wrong→right word pair is the pattern, not just the right word).
      const patternMap = {};
      for (const e of errors) {
        const nC  = (e.correction  || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const nL  = (e.learner_said || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const key = e.category === 'word_choice'
          ? `${e.category}:${nL}→${nC}`
          : `${e.category}:${nC}`;
        if (!patternMap[key]) {
          patternMap[key] = {
            category:    e.category,
            learnerSaid: e.learner_said,
            correction:  e.correction,
            explanation: e.explanation,
            sessions:    new Set(),
            count:       0,
          };
        }
        patternMap[key].sessions.add(e.session_id);
        patternMap[key].count++;
      }

      const clusteredMap = await clusterPatternsBySemantic(patternMap).catch(() => patternMap);
      const patterns = Object.values(clusteredMap)
        .filter(p => p.sessions.size >= 2)
        .sort((a, b) => b.sessions.size - a.sessions.size || b.count - a.count)
        .map(({ sessions, ...rest }) => ({ ...rest, sessionCount: sessions.size }));

      return json(200, { totalErrors: total, categories, patterns });
    }

    // GET /api/sessions/:id
    const sessMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessMatch) {
      const supabase = getSupabaseAdmin();
      if (supabase) {
        const { data: sess } = await supabase
          .from('sessions')
          .select('*, session_errors(*)')
          .eq('id', sessMatch[1])
          .maybeSingle();
        if (sess) {
          return json(200, {
            id:               sess.id,
            conversationId:   sess.conversation_id,
            createdAt:        sess.created_at,
            durationSecs:     sess.duration_secs,
            persona:          sess.persona,
            userId:           sess.user_id,
            cleanTurnStreak:  sess.clean_turn_streak,
            errors: (sess.session_errors || []).map(e => ({
              id:          e.id,
              category:    e.category,
              severity:    e.severity,
              learnerSaid: e.learner_said,
              correction:  e.correction,
              explanation: e.explanation,
              status:      e.status,
            })),
          });
        }
      }
      // Fallback to sessions.json (pre-migration data or no Supabase configured)
      const s = readJSON(SESSIONS_FILE, []).find(x => x.id === sessMatch[1]);
      return s ? json(200, s) : json(404, { error: 'Not found' });
    }

    // PATCH /api/sessions/:id/errors/:errId
    const errMatch = url.match(/^\/api\/sessions\/([^/]+)\/errors\/([^/]+)$/);
    if (method === 'PATCH' && errMatch) {
      const body     = await parseBody(req);
      const supabase = getSupabaseAdmin();
      if (supabase) {
        const { data, error } = await supabase
          .from('session_errors')
          .update({ status: body.status })
          .eq('session_id', errMatch[1])
          .eq('id', errMatch[2])
          .select()
          .maybeSingle();
        if (!error && data) return json(200, { id: data.id, status: data.status });
      }
      // Fallback to sessions.json
      const sessions = readJSON(SESSIONS_FILE, []);
      const session  = sessions.find(x => x.id === errMatch[1]);
      if (!session) return json(404, { error: 'Session not found' });
      const err = session.errors.find(e => e.id === errMatch[2]);
      if (!err) return json(404, { error: 'Error not found' });
      err.status = body.status;
      writeJSON(SESSIONS_FILE, sessions);
      return json(200, err);
    }

    // POST /api/tts
    if (method === 'POST' && url === '/api/tts') {
      const body    = await parseBody(req);
      const { text, persona } = body;
      const voiceId = persona === 'portuguese'
        ? process.env.ELEVENLABS_VOICE_ID_PORTUGUESE
        : process.env.ELEVENLABS_VOICE_ID_FRENCH;
      if (!voiceId) return json(422, { error: 'Voice ID not configured — set ELEVENLABS_VOICE_ID_FRENCH / _PORTUGUESE in .env' });
      const audio = await elTTS(voiceId, String(text).slice(0, 500));
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length });
      return res.end(audio);
    }

    // Static files
    const filePath = path.join(__dirname, url === '/' ? 'index.html' : url);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'text/plain',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });

  } catch (err) {
    console.error('[Server]', err.message);
    json(500, { error: err.message });
  }
}).listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
