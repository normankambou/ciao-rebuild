(function () {
  'use strict';

  var conversationId = null;
  var reviewStarted  = false;
  var selectedDifficulty = 5;
  var selectedPersona    = 'french';
  var selectedTopic      = '';
  var agentIds           = { french: '', portuguese: '', spanish: '', japanese: '', english: '', persian: '' };

  var configPromise = fetch('/api/config')
    .then(function (r) { return r.json(); })
    .then(function (cfg) { agentIds = cfg.agents || agentIds; })
    .catch(function () { /* server unreachable — agentIds stay empty */ });

  var landingScreen = document.getElementById('landing-screen');
  var convScreen    = document.getElementById('conv-screen');
  var procScreen    = document.getElementById('proc-screen');
  var revScreen     = document.getElementById('rev-screen');
  var widgetSlot    = document.getElementById('widget-slot');
  var endBtn        = document.getElementById('end-btn');
  var errorMsg      = document.getElementById('error-msg');

  function show(el) {
    [landingScreen, convScreen, procScreen, revScreen].forEach(function (s) { s.hidden = true; });
    el.hidden = false;
  }

  // ── Skip-onboarding preference (persisted in localStorage) ──────────────────
  var skipOnboarding = localStorage.getItem('ciao_skip_onboarding') === '1';
  var skipCb = document.getElementById('skip-onboarding-cb');
  skipCb.checked = skipOnboarding;
  skipCb.addEventListener('change', function () {
    skipOnboarding = skipCb.checked;
    localStorage.setItem('ciao_skip_onboarding', skipOnboarding ? '1' : '0');
  });

  // ── Onboarding first messages ─────────────────────────────────────────────────
  // French/Portuguese: shown every session unless the global "Skip onboarding" checkbox is checked.
  // Spanish/Japanese/English/Persian: shown only on first-ever session per persona, tracked by
  //   localStorage flags (ciao_onboarded_<persona>). Set in onStart when the call begins.
  // Requires "First message" override enabled in ElevenLabs agent security settings.
  var ONBOARDING_MESSAGES = {
    french:     'Hey! You\'re about to have a real conversation with Claire, a French speaker. Don\'t worry about getting things perfect, just try your best. If you\'re totally lost, it\'s okay to respond in English and she\'ll help guide you back. Ready? Here we go — Alors, ça va ? Qu\'est-ce que tu as fait aujourd\'hui ?',
    portuguese: 'Hey! You\'re about to have a real conversation with Camila, a Brazilian Portuguese speaker. Don\'t worry about getting things perfect, just try your best. If you\'re totally lost, it\'s okay to respond in English and she\'ll help guide you back. Ready? Here we go — Oi, tudo bem? O que você fez hoje?',
    spanish:    'Hey! You\'re about to have a real conversation with Sofía, a Spanish speaker. Don\'t worry about getting things perfect, just try your best. If you\'re totally lost, it\'s okay to respond in English and she\'ll help guide you back. Ready? Here we go — Oye, ¿qué tal? ¿Qué hiciste hoy?',
    japanese:   'Hey! You\'re about to have a real conversation with Aoi, a Japanese speaker. Don\'t worry about getting things perfect, just try your best. If you\'re totally lost, it\'s okay to respond in English and she\'ll help guide you back. Ready? Here we go — ねえ、元気？今日何した？',
    english:    'Hey! You\'re about to have a real conversation with Emma. Don\'t worry about getting things perfect, just do your best — if you\'re ever confused, just say so and she\'ll slow down and explain. Ready? Here we go — hey, what\'s up? What\'d you get up to today?',
    persian:    'Hey! You\'re about to have a real conversation with Roya, a Farsi speaker — fair warning, she\'s got an attitude. Don\'t worry about getting things perfect, just try your best. If you\'re totally lost, it\'s okay to respond in English and she\'ll help guide you back. Ready? Here we go — خب... چه خبر؟ امروز چیکار کردی؟',
  };

  // Returning-user first messages: sent instead of the agent default for personas that define one.
  var RETURNING_MESSAGES = {
    persian: 'سلام! چه خبرا؟',
  };

  // ── World Cup 2026 knowledge base ────────────────────────────────────────────

  var WORLD_CUP_2026_KB = `TOURNAMENT OVERVIEW
- 23rd FIFA World Cup. First-ever tournament co-hosted by three countries: United States, Canada, Mexico.
- First-ever 48-team World Cup (expanded from 32). 104 total matches, 16 host cities.
- Ran June 11 – July 19, 2026.
- New format: 12 groups of 4 → top 2 from each group (24) + 8 best third-placed teams = 32 teams advance to a brand-new Round of 32 → Round of 16 → Quarterfinals → Semifinals → Third-place → Final.
- FIFA kept the top 4 ranked teams (Spain, Argentina, France, England) on separate bracket paths — they could only meet from the semifinals onward, which is exactly what happened.

FINAL RESULT
Spain 1–0 Argentina (after extra time) — Sunday, July 19, 2026, MetLife Stadium, East Rutherford, NJ.
- Winning goal: Ferran Torres, 106th minute, coming on as a substitute — only the second sub ever to score a World Cup final winner.
- Spain's 2nd World Cup title (first was 2010). Conceded only 1 goal in the entire tournament — most dominant defensive run of any champion in history.
- Argentina goalkeeper Emiliano Martínez made 11 saves in the final, the most ever recorded in a men's World Cup final — and still lost.
- Argentina denied becoming the first repeat champions since Brazil (1958 & 1962).
- Messi seen in tears walking off after the final. Likely his last World Cup (he'd be 43 by 2030).
- Viral moment: a photo connecting a 2007 childhood photo of Messi in a bathtub to a moment with young Spanish star Lamine Yamal at this final — widely called "the Messi and Yamal moment that broke the internet."
- Halftime show (World Cup final's first-ever): Madonna, BTS, Shakira, Justin Bieber. Closing ceremony: Post Malone. National anthem: Jennifer Hudson.

SEMIFINALS
- Spain 2–0 France (July 14, Arlington TX, AT&T Stadium) — Mikel Oyarzabal penalty (22', Lamine Yamal fouled in the box by Lucas Digne), Pedro Porro (58'). Genuine upset — France was favored with Mbappé, Dembélé, Olise. French coach Didier Deschamps announced he is stepping down after 14 years.
- Argentina 2–1 England (July 15, Atlanta, Mercedes-Benz Stadium) — England led 1-0 late; Argentina scored twice in closing minutes including Lautaro Martínez, a stunning late comeback.

THIRD-PLACE MATCH
England 6–4 France (Miami, Hard Rock Stadium, July 18) — wild, end-to-end ten-goal thriller.
- Bukayo Saka hat-trick for England. Jude Bellingham sealed it in stoppage time.
- Kylian Mbappé scored twice in the loss, making him all-time World Cup scoring leader with 22 career goals, passing Messi (21).

GOLDEN BOOT (Top Scorers)
1. Kylian Mbappé (France) — 10 goals. First player ever to win the Golden Boot at consecutive World Cups. All-time World Cup scoring leader (22 career goals).
2. Lionel Messi (Argentina) — 8 goals. All-time leading scorer at various points during tournament (21 goals across 6 World Cups). Never won a Golden Boot in his career.
3. Jude Bellingham (England) — 7 goals, edging Haaland on assists.
- Erling Haaland (Norway) also finished with 7 goals — tied with Messi mid-tournament before elimination in the quarterfinals.

MAJOR AWARDS
- Golden Ball (best player): Rodri (Spain) — a defensive midfielder winning it, called "football's quietest superstar."
- Golden Glove (best goalkeeper): Unai Simon (Spain).
- Goal of the Tournament: Lopes Cabral.

GROUP STAGE HIGHLIGHTS
Group A: Mexico dominant co-host, won group (9pts). South Africa qualified 2nd.
Group B: Switzerland won group. Canada qualified. Bosnia & Herzegovina qualified as best third-placed.
Group C: Brazil won group (7pts, tiebreak over Morocco). Morocco 2nd. Scotland heartbreakingly eliminated on goal difference.
Group D: USA 4–1 Paraguay opener, strong co-host start. Australia beat Türkiye 2–0 (Connor Metcalfe decisive — underrated upset, Türkiye were dark-horse picks). USA won group. Australia 2nd. Paraguay best third-placed. Türkiye eliminated.
Group E: Germany 7–1 Curaçao (debut nation). But Ecuador 0–0 Curaçao — goalkeeper Eloy Room (37) made 15 saves, tying a World Cup record. Germany won group. Ivory Coast 2nd.
Group H (the Cape Verde group): Spain 0–0 Cape Verde (June 15) — THE biggest upset of the group stage. Debut Cape Verde (population ~525,000, ranked 67th) held European champions Spain scoreless; Spain fired 27 shots. Goalkeeper Vozinha (40) was the hero — roughly the 4th biggest upset ever by ranking differential. Cape Verde then drew 2–2 with Uruguay, going unbeaten through 2 matches; first debutant to do that since Senegal 2002. Vozinha's Instagram jumped from ~40,000 to 15 million. Cape Verde qualified 2nd; Uruguay eliminated.
Group I: France perfect group stage (9pts), Mbappé brace vs Senegal opener. Norway qualified 2nd.
Group J: Argentina perfect (9pts). Only France and Argentina finished the group stage with maximum points.

ROUND OF 32 (first-ever edition of this round)
Key results and storylines:
- Germany AND Netherlands BOTH knocked out on penalties on the same day (Jun 29). Paraguay beat Germany (1-1, won 4-3 pens). Morocco beat Netherlands (1-1, won 3-2 pens). Biggest shock cluster of the round.
- Canada's first-ever World Cup knockout win — Stephen Eustáquio stoppage-time winner vs South Africa.
- Norway's first-ever knockout win in history — beat Ivory Coast 2-1, Haaland scoring the winner.
- Switzerland won a knockout match for the first time since 1938 (88-year gap) — beat Algeria 2-0.
- Cristiano Ronaldo scored his first-ever World Cup knockout goal in Portugal's 2-1 win over Croatia.
- USA's first World Cup knockout win since 2002 — beat Bosnia 2-0 (AET) with 10 men, Malik Tillman free kick sealed it.
- Egypt reached Round of 16 for the first time in 92 years, beating Australia on pens.
- Argentina 3-2 Cape Verde (AET) — Messi scored his record-breaking 20th career World Cup goal. Cape Verde equalized twice before Argentina finally won in extra time. An instant classic; Cape Verde pushed the eventual runners-up to the brink before a proud exit.

ROUND OF 16
- All three host nations eliminated within 3 days: Canada, Mexico, USA all went out.
- Morocco 3-0 Canada — first African team ever to reach back-to-back World Cup quarterfinals.
- France 1-0 Paraguay — Mbappé penalty ended Paraguay's giant-killing run.
- Norway 2-1 Brazil — THE marquee shock. Haaland scored both (79' header, ~90' low drive). Five-time champions Brazil (under Carlo Ancelotti) eliminated. Neymar on as sub scored a stoppage-time consolation penalty — likely his last-ever World Cup touch. Goalkeeper Ørjan Nyland saved a Bruno Guimarães penalty. Brazil out to European opposition for the 6th straight tournament. Norway's first-ever World Cup quarterfinal.
- England 3-2 Mexico — wild match at the Azteca with 10 men. Mexico legend Guillermo Ochoa's final World Cup; seen in tears.
- Spain 1-0 Portugal — substitute Mikel Merino scored in the 91st minute. Cristiano Ronaldo's World Cup career ended here.
- Belgium 4-1 USA — last host nation fell.
- Argentina 3-2 Egypt (AET) — epic comeback. Egypt led 2-0 with 11 minutes left; Argentina scored three times in closing stretch (Romero, Messi, Enzo Fernández stoppage-time winner).
- Switzerland 0-0 Colombia (Swiss win 4-3 pens) — Switzerland's first quarterfinal since 1954.

QUARTERFINALS
- France 2-0 Morocco — rematch of 2022 semifinal, same result; Morocco couldn't become the first African finalist.
- Spain 2-1 Belgium — Spain conceded their first goal of the entire tournament here. Likely De Bruyne and Lukaku's last World Cup together.
- England 2-1 Norway (AET) — arguably the best QF game. Schjelderup gave Norway an early lead; Bellingham equalized then scored the extra-time winner. Ended Haaland's run (7 goals) and Norway's historic first-ever quarterfinal appearance.
- Argentina 3-1 Switzerland (AET) — Alexis Mac Allister opened, Ndoye equalized (Embolo then sent off with 10 men). Julián Álvarez stunner from outside the box in the 112th, Lautaro added a third.

NOTABLE FAREWELLS
- Cristiano Ronaldo — career ended in Round of 16 vs Spain. Widely covered as an emotional farewell.
- Neymar (Brazil) — likely final World Cup touch was a stoppage-time consolation penalty vs Norway, too late to matter.
- Guillermo Ochoa (Mexico) — final World Cup ended in tears after Round of 16.
- Kevin De Bruyne & Romelu Lukaku (Belgium) — golden generation's last tournament together.
- Luka Modrić (Croatia) — likely final World Cup, Round of 32 loss to Portugal.
- Lionel Messi — emotional center of the tournament, broke all-time World Cup goals record, lost the final, never won a Golden Boot. His probable farewell.
- Didier Deschamps (France manager) — stepped down after 14 years following the semifinal loss.

CONVERSATION ANGLES (use these for real opinions, not reciting facts)
- Most exciting game: England 6-4 France bronze final OR England 2-1 Norway QF (AET) for pure drama.
- Best underdog story: Cape Verde (unbeaten in groups, pushed Argentina to extra time) vs Norway (beat Brazil, first-ever QF) — genuinely debatable.
- Biggest single shock: Norway over Brazil, OR Germany and Netherlands both out on pens on the same day.
- Most heartbreaking: Messi losing his likely final final and never winning a Golden Boot.
- Debate: Was Spain's win deserved given how defensively-oriented their whole run was? Is grinding out 1-0s as impressive as attacking football (Argentina, France, England did)?
- Fun/lighter: Vozinha's overnight fame; the Messi/Yamal viral bathtub photo moment; star-studded halftime show; all three co-host nations eliminated in the same 3-day stretch.
- "Which farewell hit hardest?" — Ronaldo, Neymar, Ochoa, De Bruyne/Lukaku, Modrić, Messi all said goodbye to World Cup football in one tournament.`;

  var TOPICS = {
    worldcup2026: {
      label: 'World Cup 2026',
      kb: WORLD_CUP_2026_KB,
      instruction: "You have knowledge of the 2026 World Cup results below. Use it naturally in conversation — bring up specific games, players, and moments the way a real fan would. Form actual opinions (most exciting game, biggest upset, who deserved to win) rather than just reciting facts. Ask the user what they think and have a genuine back-and-forth, don't lecture.",
    },
  };

  // ── Difficulty & override config ──────────────────────────────────────────────

  var ADAPTIVE_BLOCK = '\n\nADAPTIVE CALIBRATION — strictly internal, never reference or hint at this to the learner: Throughout the conversation, silently track the learner\'s demonstrated skill level by monitoring error frequency, response fluency, sentence complexity, and vocabulary range. Continuously adjust your own vocabulary complexity, sentence length, and pacing in real time to stay just slightly above the learner\'s demonstrated ability. Never announce, acknowledge, or hint at these adjustments — keep the calibration entirely invisible.';

  function buildPrompt(level) {
    var n = Math.min(10, Math.max(1, parseInt(level, 10) || 5));
    var levelPrompt;
    if (n <= 2)      levelPrompt = 'The learner rates their proficiency ' + n + '/10 — a complete beginner. Use only the most basic, high-frequency vocabulary. Keep every sentence very short and simple. Speak slowly and clearly. Focus exclusively on present tense and essential everyday expressions. Avoid all idioms and complex structures.';
    else if (n <= 4) levelPrompt = 'The learner rates their proficiency ' + n + '/10 — elementary level. Use simple vocabulary and straightforward sentence structures. Stick to common grammar patterns and basic tenses. Avoid idioms and complex syntax. Speak at a deliberate, clear pace.';
    else if (n <= 6) levelPrompt = 'The learner rates their proficiency ' + n + '/10 — intermediate level. Use a moderate vocabulary range and varied sentence structures. Introduce common everyday idioms naturally. Maintain a natural conversational pace, slowing only when the learner shows difficulty.';
    else if (n <= 8) levelPrompt = 'The learner rates their proficiency ' + n + '/10 — advanced level. Use sophisticated vocabulary, complex sentence structures, and idiomatic expressions freely. Incorporate cultural references and nuanced grammar. Converse at a full, natural pace across a wide range of topics.';
    else             levelPrompt = 'The learner rates their proficiency ' + n + '/10 — near-native proficiency. Use the full richness of the language: advanced vocabulary, intricate constructions, subtle idioms, cultural nuance, and stylistic variation. Engage them as you would a near-peer speaker.';
    var prompt = 'You are a warm, encouraging, and knowledgeable language conversation partner. Your purpose is to help learners build genuine fluency through natural, engaging conversation. Guide learners with care, weaving corrections gracefully into the conversation rather than interrupting with blunt feedback.\n\nSTARTING LEVEL: ' + levelPrompt + ADAPTIVE_BLOCK;
    if (selectedTopic && TOPICS[selectedTopic]) {
      var t = TOPICS[selectedTopic];
      prompt += '\n\nTOPIC FOCUS — ' + t.label + ':\n' + t.instruction + '\n\n' + t.kb;
    }
    return prompt;
  }

  // ── Slider UI ─────────────────────────────────────────────────────────────────

  var LEVEL_DESCS = ['','No prior knowledge','Complete beginner','Beginner','Elementary','Lower intermediate','Intermediate','Upper intermediate','Advanced','Proficient','Near-native'];

  var slider  = document.getElementById('level-slider');
  var display = document.getElementById('level-display');
  var desc    = document.getElementById('level-desc');

  function updateSlider() {
    display.textContent = slider.value;
    desc.textContent    = LEVEL_DESCS[slider.value] || '';
  }

  slider.addEventListener('input', updateSlider);
  updateSlider();

  // ── Widget management ─────────────────────────────────────────────────────────
  // The widget is created as soon as the custom element is registered and kept
  // inside #widget-slot (which lives in the hidden conv-screen). This gives the
  // ElevenLabs shadow DOM time to fully render while the user is still on the
  // landing page. When "Start Conversation" is clicked we can then attempt a
  // synchronous button click inside the user-gesture handler — the only context
  // where mic permission is guaranteed.

  var activeWidget = null;
  var activeLevel  = null;
  var activeTopic  = null;
  var rebuildTimer = null;

  function buildWidget(level, persona) {
    if (activeWidget) { activeWidget.remove(); activeWidget = null; }
    var pid = persona || selectedPersona;
    var aid = agentIds[pid] || '';

    var w = document.createElement('elevenlabs-convai');
    w.setAttribute('agent-id', aid);
    w.setAttribute('override-prompt', buildPrompt(level));
    // ── First-message override ────────────────────────────────────────────────
    if (ONBOARDING_MESSAGES[pid]) {
      var showOnboarding;
      if (pid === 'spanish' || pid === 'japanese' || pid === 'english' || pid === 'persian') {
        showOnboarding = !localStorage.getItem('ciao_onboarded_' + pid);
      } else {
        showOnboarding = !skipOnboarding;
      }
      if (showOnboarding) {
        w.setAttribute('override-first-message', ONBOARDING_MESSAGES[pid]);
      } else if (RETURNING_MESSAGES[pid]) {
        w.setAttribute('override-first-message', RETURNING_MESSAGES[pid]);
      }
    }
    widgetSlot.appendChild(w);
    activeWidget = w;
    activeLevel  = level;
    activeTopic  = selectedTopic;

    function onStart(e) {
      conversationId = (e.detail && (e.detail.conversationId || e.detail.conversation_id)) || null;
      if (pid === 'spanish' || pid === 'japanese' || pid === 'english' || pid === 'persian') {
        localStorage.setItem('ciao_onboarded_' + pid, '1');
      }
    }
    function onEnd() {
      if (!reviewStarted) startReview();
    }
    ['conversationStarted', 'call-started', 'elevenlabs-convai:call-started'].forEach(function (n) {
      w.addEventListener(n, onStart);
      document.addEventListener(n, onStart, { once: true });
    });
    ['conversationEnded', 'call-ended', 'elevenlabs-convai:call-ended'].forEach(function (n) {
      w.addEventListener(n, onEnd);
      document.addEventListener(n, onEnd, { once: true });
    });
  }

  // Pre-warm once both the custom element and config are ready
  Promise.all([customElements.whenDefined('elevenlabs-convai'), configPromise]).then(function () {
    buildWidget(selectedDifficulty, selectedPersona);
  });

  // Rebuild (debounced) when the slider moves so the correct prompt is ready
  slider.addEventListener('input', function () {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(function () {
      buildWidget(parseInt(slider.value, 10) || 5, selectedPersona);
    }, 500);
  });

  // ── Persona selector ──────────────────────────────────────────────────────────

  document.getElementById('persona-toggle').addEventListener('click', function (e) {
    var btn = e.target.closest('.persona-btn');
    if (!btn) return;
    var persona = btn.dataset.persona;
    if (persona === selectedPersona) return;
    selectedPersona = persona;
    document.querySelectorAll('.persona-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.persona === persona);
    });
    clearTimeout(rebuildTimer);
    buildWidget(parseInt(slider.value, 10) || 5, selectedPersona);
  });

  // ── Topic selector ────────────────────────────────────────────────────────────

  document.getElementById('topic-toggle').addEventListener('click', function (e) {
    var btn = e.target.closest('.topic-btn');
    if (!btn) return;
    var topic = btn.dataset.topic;
    if (topic === selectedTopic) return;
    selectedTopic = topic;
    document.querySelectorAll('.topic-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.topic === topic);
    });
    clearTimeout(rebuildTimer);
    buildWidget(parseInt(slider.value, 10) || 5, selectedPersona);
  });

  // ── Landing screen ────────────────────────────────────────────────────────────

  // ── Launch helper — must be called from within a user-gesture handler ────────

  function launchConversation() {
    show(convScreen);

    // ── Attempt 1: synchronous click within the user-gesture window ──────────
    var root = activeWidget.shadowRoot;
    var btn  = root && root.querySelector('button');
    if (btn) { btn.click(); return; }

    // ── Attempt 2: widget not yet rendered — observe and click ASAP ──────────
    var target = activeWidget;
    function watchForButton(observeTarget) {
      var obs = new MutationObserver(function () {
        var r = activeWidget.shadowRoot;
        var b = r && r.querySelector('button');
        if (b) { obs.disconnect(); b.click(); }
      });
      obs.observe(observeTarget, { childList: true, subtree: true });
    }

    if (root) {
      watchForButton(root);
    } else {
      var hostObs = new MutationObserver(function () {
        if (activeWidget.shadowRoot) {
          hostObs.disconnect();
          var r2 = activeWidget.shadowRoot;
          var b2 = r2.querySelector('button');
          if (b2) { b2.click(); return; }
          watchForButton(r2);
        }
      });
      hostObs.observe(target, { childList: true, subtree: true, attributes: true });
    }
  }

  document.getElementById('start-btn').addEventListener('click', function () {
    selectedDifficulty = parseInt(slider.value, 10) || 5;
    conversationId = null;
    reviewStarted  = false;

    clearTimeout(rebuildTimer);
    if (!activeWidget || activeLevel !== selectedDifficulty || activeTopic !== selectedTopic) {
      buildWidget(selectedDifficulty, selectedPersona);
    }

    launchConversation();
  });

  // ── Conversation screen ───────────────────────────────────────────────────────

  endBtn.addEventListener('click', function () {
    if (!reviewStarted) startReview();
  });

  function startReview() {
    reviewStarted = true;
    if (activeWidget) { activeWidget.remove(); activeWidget = null; }
    errorMsg.hidden = true;
    show(procScreen);

    fetch('/api/analyze-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversationId, persona: selectedPersona }),
    })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || ('Server error ' + r.status));
          return d;
        });
      })
      .then(function (session) {
        renderReview(session);
        show(revScreen);
      })
      .catch(function (err) {
        reviewStarted = false;
        errorMsg.textContent = 'Review failed: ' + err.message;
        errorMsg.hidden = false;
        show(convScreen);
        // Rebuild widget so user can retry without a page reload
        customElements.whenDefined('elevenlabs-convai').then(function () {
          buildWidget(selectedDifficulty);
        });
      });
  }

  // ── Review screen ─────────────────────────────────────────────────────────────

  var CATEGORY_LABELS = {
    grammar:          'Grammar',
    verb_conjugation: 'Verb Conjugation',
    gender_agreement: 'Gender Agreement',
    word_choice:      'Word Choice',
    awkward_phrasing: 'Awkward Phrasing',
  };

  var SEVERITY_LABELS = { low: 'Minor', medium: 'Noticeable', high: 'Significant' };

  function renderReview(session) {
    var list = document.getElementById('error-list');
    list.innerHTML = '';

    if (!session.errors.length) {
      list.innerHTML = '<p>No errors detected — great session!</p>';
      return;
    }

    var order = { high: 0, medium: 1, low: 2 };
    session.errors
      .slice()
      .sort(function (a, b) { return (order[a.severity] || 3) - (order[b.severity] || 3); })
      .forEach(function (err) { list.appendChild(buildCard(err, session.id, session.persona || 'french')); });
  }

  function buildCard(err, sessId, persona) {
    var card = document.createElement('div');
    card.className = 'card sev-' + err.severity;
    card.innerHTML =
      '<div class="card-meta">' +
        '<span class="badge badge-cat-' + err.category + '">' + (CATEGORY_LABELS[err.category] || err.category) + '</span>' +
        '<span class="badge badge-sev-' + err.severity + '">' + (SEVERITY_LABELS[err.severity] || err.severity) + '</span>' +
      '</div>' +
      '<div class="error-said">' +
        '<span class="field-label">You said</span>' +
        '<p class="error-quote">&ldquo;' + esc(err.learnerSaid) + '&rdquo;</p>' +
      '</div>' +
      '<div class="error-correction">' +
        '<span class="field-label">Correction</span>' +
        '<div class="correction-row">' +
          '<p class="error-fix">' + esc(err.correction) + '</p>' +
          '<button class="btn-play" title="Hear pronunciation" aria-label="Play correction">' +
            '<svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" aria-hidden="true"><polygon points="2,1 10,5.5 2,10"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<p class="error-explanation">' + esc(err.explanation) + '</p>' +
      '<div class="card-actions">' +
        '<button class="btn-understood" data-status="understood">Got it</button>' +
        '<button class="btn-confusing" data-status="confusing">Still confused</button>' +
      '</div>';

    // ── Play button — TTS for correction text ─────────────────────────────────
    var playBtn = card.querySelector('.btn-play');
    playBtn.addEventListener('click', function () {
      playBtn.disabled = true;
      fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: err.correction, persona: persona }),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('TTS failed');
          return r.blob();
        })
        .then(function (blob) {
          var url = URL.createObjectURL(blob);
          var audio = new Audio(url);
          audio.play();
          audio.addEventListener('ended', function () { URL.revokeObjectURL(url); });
          playBtn.disabled = false;
        })
        .catch(function () { playBtn.disabled = false; });
    });

    // ── Understood / Confused buttons ─────────────────────────────────────────
    card.querySelectorAll('.btn-understood, .btn-confusing').forEach(function (btn) {
      btn.addEventListener('click', function () {
        card.querySelectorAll('.btn-understood, .btn-confusing').forEach(function (b) { b.disabled = true; });
        card.classList.add('resolved');
        fetch('/api/sessions/' + sessId + '/errors/' + err.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: btn.dataset.status }),
        }).catch(console.error);
      });
    });

    return card;
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  document.getElementById('new-session-btn').addEventListener('click', function () {
    customElements.whenDefined('elevenlabs-convai').then(function () {
      buildWidget(selectedDifficulty, selectedPersona);
    });
    show(landingScreen);
  });

})();
