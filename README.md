# Ciao

A voice-based AI language learning app. Instead of gamified drills or scripted lessons, Ciao lets you have a real, spoken conversation with an AI persona in the language you're learning — then reviews that conversation afterward to show you what you got right, what to work on, and how you're improving over time.

The core idea: most language apps teach vocabulary. Ciao gives you practice *using* it, in conversation, the way you'll actually need to when talking to a real person.

## How it works

1. **Pick a persona and a language.** Ciao currently supports 6 languages — French, Portuguese, Spanish, Japanese, English, and Persian — each with its own AI persona and voice.
2. **Have a real voice conversation.** Powered by ElevenLabs Conversational AI, the persona speaks and listens in real time, adjusting its pacing and vocabulary to your demonstrated skill level as the conversation goes — without ever announcing that it's doing so.
3. **Get a post-session review.** When the conversation ends, the transcript is analyzed by Claude to surface grammar, vocabulary, and conjugation errors — each with a clear correction and explanation.
4. **See your progress over time.** Past sessions are tracked per persona, including a CEFR-aligned fluency estimate, best "clean-turn" streaks (consecutive exchanges without an English fallback or major error), and recurring error patterns — so you can see not just *what* you got wrong, but what you keep getting wrong.

## Tech stack

| Layer | Technology |
|---|---|
| Server | Node.js (built-in `http` module) |
| Voice AI | ElevenLabs Conversational AI |
| Error analysis & fluency scoring | Claude (Anthropic API) — Sonnet + Haiku |
| Auth & database | Supabase (PostgreSQL with row-level security) |
| Deployment | Render |
| Frontend | Vanilla HTML/JS/CSS (no framework) |

## Under the hood

Every session runs through a multi-step analysis pipeline:

- **Error analysis** (Claude Sonnet) — categorizes grammar, verb conjugation, gender agreement, word choice, and phrasing errors, each with a correction and explanation.
- **Session metrics** (Claude Sonnet) — computes a CEFR-lite fluency estimate, tracks the session's longest clean-turn streak, and extracts a small set of factual, non-sensitive details about the learner (occupation, plans, preferences) to give the persona natural continuity across future sessions.
- **Struggle-pattern clustering** (Claude Haiku) — semantically groups recurring errors across a user's session history, so a mistake that keeps showing up in different sentences (e.g. a verb that's consistently misconjugated) surfaces as one pattern, not five unrelated flags.

Progress is tracked per user, per persona, in a Postgres schema with four core tables (`sessions`, `session_errors`, `persona_progress`, `persona_facts`) secured with row-level security so each user can only ever access their own data.

## Status

Ciao is a solo-built, early-stage working prototype — fully functional end-to-end, not yet publicly launched. It's deployed on Render, with a couple of known issues still being worked through before a fully self-serve public demo.

## Why I built it

Existing language apps are good at vocabulary drilling but don't build real conversational confidence — the thing that actually breaks down is the moment someone tries to speak the language with another person. Ciao is a bet on practicing the real skill directly: talking, in the moment, with something that feels less like a lesson and more like a conversation with a friend.
