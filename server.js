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

// ── Claude analysis ───────────────────────────────────────────────────────────

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
      const agentId = PERSONA_AGENTS[persona] || process.env.ELEVENLABS_AGENT_ID_FRENCH;
      const conv    = await getConversation(body.conversationId || null, agentId);
      const errors  = await analyzeTranscript(conv.transcript || []);
      const session = {
        id:             `sess_${Date.now()}`,
        conversationId: conv.conversation_id,
        createdAt:      new Date().toISOString(),
        durationSecs:   Math.round(conv.metadata?.call_duration_secs ?? 0),
        persona,
        errors: errors.map((e, i) => ({ ...e, id: `err_${i}`, status: 'open' })),
      };
      const sessions = readJSON(SESSIONS_FILE, []);
      sessions.unshift(session);
      writeJSON(SESSIONS_FILE, sessions);
      return json(200, session);
    }

    // GET /api/sessions/:id
    const sessMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessMatch) {
      const s = readJSON(SESSIONS_FILE, []).find(x => x.id === sessMatch[1]);
      return s ? json(200, s) : json(404, { error: 'Not found' });
    }

    // PATCH /api/sessions/:id/errors/:errId
    const errMatch = url.match(/^\/api\/sessions\/([^/]+)\/errors\/([^/]+)$/);
    if (method === 'PATCH' && errMatch) {
      const body     = await parseBody(req);
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
