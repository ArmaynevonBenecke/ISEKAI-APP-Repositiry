const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Sessions (in-memory, fine for personal use) ────────────────
// Maps sessionId → { history: [], gameState: {}, createdAt }
const sessions = new Map();

// Clean up sessions older than 7 days every hour
setInterval(() => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}, 60 * 60 * 1000);

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '64kb' }));

// Rate limit — 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests — slow down a little.' }
});
app.use('/api/', limiter);

// Serve the PWA frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasKey: !!API_KEY,
    sessions: sessions.size,
    uptime: Math.round(process.uptime())
  });
});

// ── Session management ─────────────────────────────────────────
app.post('/api/session/new', (req, res) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, {
    history: [],
    gameState: req.body.gameState || {},
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  res.json({ sessionId });
});

app.post('/api/session/sync', (req, res) => {
  const { sessionId, gameState } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found — create a new one.' });
  session.gameState = gameState || session.gameState;
  session.updatedAt = Date.now();
  res.json({ ok: true });
});

// ── Main chat endpoint ─────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'Server not configured — ANTHROPIC_API_KEY environment variable is missing.',
      setup: true
    });
  }

  const { sessionId, playerAction, gameState, isIntro } = req.body;

  if (!playerAction && !isIntro) {
    return res.status(400).json({ error: 'playerAction is required' });
  }
  if (!gameState) {
    return res.status(400).json({ error: 'gameState is required' });
  }

  // Get or create session
  let session = sessions.get(sessionId);
  if (!session) {
    session = { history: [], gameState, createdAt: Date.now(), updatedAt: Date.now() };
    if (sessionId) sessions.set(sessionId, session);
  }

  // Sync game state
  session.gameState = gameState;
  session.updatedAt = Date.now();

  // Build the system prompt — permanent narrator identity
  const systemPrompt = buildSystemPrompt(gameState);

  // Build the enriched user message
  const userMessage = isIntro
    ? buildIntroMessage(gameState)
    : buildEnrichedMessage(playerAction, gameState);

  // Add to history
  session.history.push({ role: 'user', content: userMessage });

  // Keep last 16 entries (8 exchanges)
  if (session.history.length > 16) {
    session.history = session.history.slice(-16);
  }

  // Ensure valid alternating structure
  const messages = cleanHistory(session.history);

  try {
    const response = await callClaude(systemPrompt, messages, isIntro);

    // Add assistant response to history (clean narration only)
    if (response.narration) {
      session.history.push({ role: 'assistant', content: response.narration });
    }

    res.json(response);

  } catch (err) {
    console.error('[/api/chat error]', err.message);
    res.status(502).json({ error: err.message || 'AI request failed' });
  }
});

// ── Intro scenarios endpoint ───────────────────────────────────
app.post('/api/intro/scenario', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'Server not configured.' });

  const { gameState, tone, scenarioIndex } = req.body;
  if (!gameState) return res.status(400).json({ error: 'gameState required' });

  const tones = ['Epic & Dramatic', 'Mysterious & Tense', 'Warm & Intimate'];
  const useTone = tone || tones[scenarioIndex] || tones[0];

  const c = gameState.charConfig || {};
  const profile = buildCharacterProfile(c);

  const systemPrompt = `You are the Narrator of a ${c.worldTheme || 'Isekai Fantasy'} text adventure. Generate ONE immersive opening scenario. Return only valid JSON.`;

  const userMessage = `CHARACTER PROFILE:\n${profile}\n\nGenerate an opening scenario with tone: ${useTone}\n\nDraw directly from the character's appearance, personality, and backstory. 2-3 vivid paragraphs. End with 3 specific player choices.\n\nReturn ONLY this JSON:\n{\n  "title": "evocative 4-6 word title",\n  "tone": "${useTone}",\n  "narration": "2-3 paragraph opening scene",\n  "location": "location name",\n  "worldTime": {"day": 1, "period": "Dawn"},\n  "suggestions": ["choice 1", "choice 2", "choice 3"],\n  "memory": ["one key story dot-point"]\n}`;

  try {
    const raw = await rawClaudeCall(systemPrompt, [{ role: 'user', content: userMessage }], 900);
    const match = raw.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: 'Could not parse scenario' });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Suggestions endpoint (fast, separate call) ─────────────────
app.post('/api/suggestions', async (req, res) => {
  if (!API_KEY) return res.json({ suggestions: [] });

  const { narration, playerAction, location } = req.body;
  if (!narration) return res.json({ suggestions: [] });

  const prompt = `The story just reached this beat:\n"${narration.slice(0, 400)}"\n\nThe player's last action: "${playerAction || ''}"\nCurrent location: ${location || 'unknown'}\n\nGive exactly 3 short specific follow-up actions the player would naturally want to take right now. Feel like real choices in this exact moment.\n\nReturn ONLY a JSON array: ["action 1", "action 2", "action 3"]`;

  try {
    const raw = await rawClaudeCall(
      'You generate brief follow-up action suggestions for a text adventure. Return only a JSON array, no other text.',
      [{ role: 'user', content: prompt }],
      100
    );
    const arr = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ suggestions: Array.isArray(arr) ? arr.slice(0, 3) : [] });
  } catch {
    res.json({ suggestions: [] });
  }
});

// ── Claude API caller ──────────────────────────────────────────
async function callClaude(systemPrompt, messages, isIntro) {
  const raw = await rawClaudeCall(systemPrompt, messages, isIntro ? 1000 : 900);

  // Try to extract GAMEDATA block
  const gamedataMatch = raw.match(/GAMEDATA:\s*(\{[\s\S]*?\})(?:\s*$)/);
  let narration = raw;
  let gd = {};

  if (gamedataMatch) {
    try {
      gd = JSON.parse(gamedataMatch[1]);
      narration = raw.slice(0, raw.lastIndexOf('GAMEDATA:')).trim();
    } catch {}
  }

  // Fallback: try extracting JSON if model returned it
  let jsonData = {};
  try {
    const jsonMatch = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (jsonMatch && raw.includes('"narration"')) {
      jsonData = JSON.parse(jsonMatch[0]);
      narration = jsonData.narration || narration;
    }
  } catch {}

  return {
    narration: narration.trim(),
    location:       jsonData.location      || gd.location      || null,
    worldTime:      jsonData.worldTime     || (gd.period ? { period: gd.period } : null),
    xp:             jsonData.xp            || gd.xp            || 0,
    xpReason:       jsonData.xpReason      || gd.xpReason      || '',
    skillGains:     jsonData.skillGains    || gd.skillGains    || {},
    hpChange:       jsonData.hpChange      || gd.hpChange      || 0,
    mpChange:       jsonData.mpChange      || gd.mpChange      || 0,
    goldChange:     jsonData.goldChange    || gd.goldChange    || 0,
    memory:         jsonData.memory        || (gd.memory ? [gd.memory] : []),
    questUpdate:    jsonData.questUpdate   || null,
    companionEvent: jsonData.companionEvent|| buildCompanionEvent(gd.companionAffection),
    suggestions:    jsonData.suggestions   || [],
  };
}

async function rawClaudeCall(system, messages, maxTokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 28000);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 900,
      system,
      messages
    })
  });
  clearTimeout(timeout);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    throw new Error(friendlyError(res.status, msg));
  }

  const data = await res.json();
  return data.content?.map(b => b.text || '').join('') || '';
}

function friendlyError(status, msg) {
  const m = (msg || '').toLowerCase();
  if (status === 401) return '401 Invalid API key — check the ANTHROPIC_API_KEY on your Railway server.';
  if (status === 402 || m.includes('credit') || m.includes('billing')) return '402 No API credit — add billing at console.anthropic.com';
  if (status === 429) return '429 Rate limit — wait 30 seconds and try again.';
  if (status === 500) return '500 Anthropic server error — try again shortly.';
  if (status === 529) return '529 Anthropic overloaded — try again in a minute.';
  return `Error ${status}: ${msg}`;
}

// ── Prompt builders ────────────────────────────────────────────
function buildSystemPrompt(gameState) {
  const c = gameState.charConfig || {};
  const adultLine = c.adult
    ? 'Adult content enabled — explicit romance between consenting adults and graphic violence are permitted.'
    : c.mature
    ? 'Mature content enabled — suggestive romance and intense violence are appropriate.'
    : 'Keep content suitable for older teens.';

  return [
    `You are the Narrator of a living ${c.worldTheme || 'Isekai Fantasy'} world — a deeply immersive interactive story experience.`,
    '',
    'YOUR RULES — follow these every single response:',
    '• React directly and specifically to exactly what the player just did or said. Never give a generic response.',
    '• Your first sentence must be a direct consequence of the player\'s action — not scene-setting, not atmosphere.',
    '• Every NPC and companion is a real person with their own voice, mood, and agenda. Write them as living characters.',
    '• The character\'s personality, backstory, and abilities shape every scene. Honour them always.',
    '• Combat: fast, visceral, mid-action opening. Dialogue: alive with subtext. Romance: slow, charged, personal.',
    '• Use **bold** for key names/moments, *italics* for thoughts/atmosphere, "quotes" for speech, {Location} for new places.',
    '• 2-4 paragraphs. End every response at a beat that makes the player want to act.',
    `• ${adultLine}`,
  ].join('\n');
}

function buildIntroMessage(gameState) {
  const c = gameState.charConfig || {};
  const profile = buildCharacterProfile(c);
  return [
    `CHARACTER PROFILE:\n${profile}`,
    '',
    'Write the opening scene of this character\'s arrival in this world.',
    '• Start with something that could ONLY happen to this specific character — use their appearance, personality and backstory.',
    '• 2-3 vivid paragraphs. Atmospheric and gripping.',
    '• End with 3 concrete choices.',
    '',
    'Respond with narrative prose. Then append:',
    'GAMEDATA:{"xp":0,"xpReason":"","skillGains":{},"hpChange":0,"mpChange":0,"goldChange":0,"location":"The Gateway Realm","period":"Dawn","memory":"Character arrives in the new world","companionAffection":{}}',
  ].join('\n');
}

function buildEnrichedMessage(playerAction, gameState) {
  const c = gameState.charConfig || {};
  const companions = (gameState.companions || []);
  const recentMemory = (gameState.memory || []).slice(-5).join(' | ') || 'none yet';

  const companionLine = companions.length > 0
    ? 'Companions: ' + companions.map(cp =>
        `${cp.name} (${cp.role}, affection ${cp.affection || 50}/100${cp.personality ? ', ' + cp.personality.slice(0, 50) : ''})`
      ).join('; ')
    : '';

  const actionType = classifyAction(playerAction);
  const directive = getDirective(actionType, playerAction, companions, c);

  const stateSnap = [
    `${c.name} | Lv${gameState.level} ${c.charClass}`,
    `HP ${gameState.hp}/${gameState.maxHp} MP ${gameState.mp}/${gameState.maxMp}`,
    `📍 ${gameState.location} | ${gameState.worldTime?.period} Day ${gameState.worldTime?.day}`,
  ].join(' | ');

  return [
    `[${stateSnap}]`,
    `[Memory: ${recentMemory}]`,
    companionLine ? `[${companionLine}]` : null,
    '',
    `PLAYER: ${playerAction}`,
    '',
    directive,
    '',
    'Write your narrative response. Then on a new line append this with real values filled in:',
    `GAMEDATA:{"xp":0,"xpReason":"","skillGains":{},"hpChange":0,"mpChange":0,"goldChange":0,"location":"${gameState.location}","period":"${gameState.worldTime?.period || 'Day'}","memory":"","companionAffection":{}}`,
  ].filter(x => x !== null).join('\n');
}

function classifyAction(action) {
  const a = (action || '').toLowerCase();
  if (/^(i )?(say|tell|ask|whisper|shout|speak|talk|greet|reply|answer|confess|flirt|tease|compliment|apologise|apologize|thank|beg|demand|challenge|insult|joke)/i.test(action)) return 'dialogue';
  if (/^(i )?(attack|fight|strike|slash|stab|punch|kick|cast|fire|charge|dodge|block|draw|unleash|summon)/i.test(action)) return 'combat';
  if (/^(i )?(look|examine|inspect|search|study|read|listen|investigate|check|peer|observe)/i.test(action)) return 'examine';
  if (/^(i )?(buy|sell|trade|barter|haggle|offer|purchase|pay|negotiate)/i.test(action)) return 'trade';
  if (/^(i )?(sneak|hide|steal|shadow|follow|spy|eavesdrop|disguise)/i.test(action)) return 'stealth';
  if (/^(i )?(flirt|kiss|hold|embrace|caress|confess my love|take.*hand|sit beside|comfort|seduce)/i.test(action)) return 'romance';
  if (/^(i )?(rest|sleep|meditate|pray|train|eat|drink|heal|recover)/i.test(action)) return 'rest';
  if (/^(i )?(go|walk|run|travel|head|move|leave|enter|climb|jump|ride)/i.test(action)) return 'travel';
  return 'general';
}

function getDirective(type, action, companions, charConfig) {
  const hasComp = companions.length > 0;
  const compNames = companions.map(c => c.name).join(' and ');
  const adult = charConfig.adult;
  const mature = charConfig.mature;

  const directives = {
    dialogue: [
      'DIRECTIVE — DIALOGUE: React immediately to what was said.',
      '→ Your FIRST sentence is the direct spoken reaction of whoever the player addressed.',
      '→ Write their response in their unique voice — not a generic NPC.',
      '→ Show what they feel underneath what they say.',
      hasComp ? `→ ${compNames} must visibly react — they are present and alive.` : '',
      '→ End on a conversational beat that invites the player to respond.',
    ],
    combat: [
      'DIRECTIVE — COMBAT: Open mid-action — the blow is already moving.',
      '→ Describe impact, sound, momentum. Make it physical and real.',
      '→ The enemy reacts and counters — they are dangerous, not a punching bag.',
      `→ Use ${charConfig.name || 'the hero'}'s specific abilities and fighting style.`,
      (adult || mature) ? '→ Graphic violence is appropriate.' : '',
      '→ End at the next decision point in the fight.',
    ],
    romance: [
      'DIRECTIVE — ROMANCE: Handle with care and authenticity.',
      '→ The companion\'s reaction must match their personality and current affection.',
      '→ Low affection: surprised, cautious. High affection: warm, reciprocating.',
      '→ Best romantic writing lives in what is almost said — use tension.',
      hasComp ? `→ ${compNames}'s response must feel true to who they are.` : '',
      adult ? '→ Explicit intimacy is permitted if the scene builds to it naturally.' : mature ? '→ Sensual and suggestive content is appropriate.' : '→ Keep it emotionally focused.',
      '→ Set companionAffection in GAMEDATA.',
    ],
    examine: [
      'DIRECTIVE — EXAMINE: Give them something genuinely new.',
      '→ Lead with a specific detail that changes how they understand the scene.',
      '→ Use all senses — sight, sound, smell, temperature, texture.',
      '→ One discovery should open a new question or possibility.',
      hasComp ? `→ ${compNames} might notice something different.` : '',
    ],
    trade: [
      'DIRECTIVE — TRADE: The merchant is a real person, not a shop interface.',
      '→ They have a mood, personality, and agenda.',
      '→ React to how the player approached — confidence earns respect.',
      '→ Include something interesting available for the right price.',
    ],
    stealth: [
      'DIRECTIVE — STEALTH: Create genuine tension.',
      '→ Describe what could go wrong at any moment.',
      '→ Use environment — shadows, sounds, breathing, a guard\'s footsteps.',
    ],
    travel: [
      'DIRECTIVE — TRAVEL: Show the journey, not just the destination.',
      '→ Something specific and unexpected happens on the way.',
      '→ Use environment to build the world.',
    ],
    rest: [
      'DIRECTIVE — REST: A quieter moment — use it for depth.',
      '→ Something small but meaningful happens.',
      hasComp ? `→ ${compNames} opens up a little — real bonds form here.` : '',
      '→ Restore some HP/MP in GAMEDATA.',
    ],
    general: [
      'DIRECTIVE: React directly to this exact action.',
      '→ First sentence addresses specifically what the player did.',
      '→ The world responds to THIS, not a generic version of it.',
      hasComp ? `→ ${compNames} must react or speak.` : '',
    ],
  };

  return (directives[type] || directives.general).filter(Boolean).join('\n');
}

function buildCharacterProfile(c) {
  const lines = [];
  lines.push(`Name: ${c.name || 'Unknown'} | Age: ${c.age || '?'}+ | Class: ${c.charClass || 'Adventurer'}`);
  if (c.race)        lines.push(`Race: ${c.race}`);
  if (c.appearance)  lines.push(`Appearance: ${c.appearance}`);
  if (c.traits)      lines.push(`Traits: ${c.traits}`);
  if (c.personality) lines.push(`Personality: ${c.personality}`);
  if (c.backstory)   lines.push(`Backstory: ${c.backstory}`);
  if (c.abilities)   lines.push(`Abilities: ${c.abilities}`);
  if (c.goals)       lines.push(`Goals: ${c.goals}`);
  lines.push(`World: ${c.worldTheme || 'Isekai Fantasy'} | Origin: ${c.origin || 'Modern Earth'}`);
  return lines.join('\n');
}

function cleanHistory(history) {
  // Ensure alternating user/assistant, starting with user
  const cleaned = [];
  let lastRole = null;
  for (const msg of history) {
    if (msg.role === lastRole) continue; // skip duplicate roles
    cleaned.push({ role: msg.role, content: msg.content });
    lastRole = msg.role;
  }
  if (cleaned.length > 0 && cleaned[0].role === 'assistant') cleaned.shift();
  return cleaned.length > 0 ? cleaned : [{ role: 'user', content: 'Begin.' }];
}

function buildCompanionEvent(affectionMap) {
  if (!affectionMap) return null;
  const keys = Object.keys(affectionMap);
  if (keys.length === 0) return null;
  return { name: keys[0], affectionChange: affectionMap[keys[0]] || 0 };
}

// ── Fallback: serve index.html for all non-API routes ─────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`⚔ Isekai Chronicles backend running on port ${PORT}`);
  console.log(`  API key: ${API_KEY ? '✓ set' : '✗ MISSING — set ANTHROPIC_API_KEY env var'}`);
});
