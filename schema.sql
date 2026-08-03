-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query).
-- Safe to re-run: uses IF NOT EXISTS and DROP POLICY IF EXISTS throughout.

-- ── Sessions ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sessions (
  id                TEXT         PRIMARY KEY,
  user_id           UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id   TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  duration_secs     INT          NOT NULL DEFAULT 0,
  persona           TEXT         NOT NULL DEFAULT 'french',
  clean_turn_streak INT          NOT NULL DEFAULT 0,
  cefr_score        NUMERIC(4,2)
);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
DROP   POLICY IF EXISTS sessions_own ON public.sessions;
CREATE POLICY sessions_own ON public.sessions FOR ALL USING (auth.uid() = user_id);

-- ── Session errors ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.session_errors (
  id           TEXT  NOT NULL,
  session_id   TEXT  NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id      UUID  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category     TEXT  NOT NULL,
  severity     TEXT  NOT NULL,
  learner_said TEXT  NOT NULL,
  correction   TEXT  NOT NULL,
  explanation  TEXT  NOT NULL,
  status       TEXT  NOT NULL DEFAULT 'open',
  PRIMARY KEY (session_id, id)
);

ALTER TABLE public.session_errors ENABLE ROW LEVEL SECURITY;
DROP   POLICY IF EXISTS session_errors_own ON public.session_errors;
CREATE POLICY session_errors_own ON public.session_errors FOR ALL USING (auth.uid() = user_id);

-- ── Persona progress ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.persona_progress (
  user_id                           UUID  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  persona                           TEXT  NOT NULL,
  session_count                     INT   NOT NULL DEFAULT 0,
  longest_clean_turn_streak_alltime INT   NOT NULL DEFAULT 0,
  cefr_tier                         TEXT,
  cefr_tier_label                   TEXT,
  recent_cefr_scores                JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, persona)
);

ALTER TABLE public.persona_progress ENABLE ROW LEVEL SECURITY;
DROP   POLICY IF EXISTS persona_progress_own ON public.persona_progress;
CREATE POLICY persona_progress_own ON public.persona_progress FOR ALL USING (auth.uid() = user_id);

-- ── Persona facts (Contextual Ledger) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.persona_facts (
  id         UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  persona    TEXT         NOT NULL,
  session_id TEXT         REFERENCES public.sessions(id) ON DELETE SET NULL,
  fact       TEXT         NOT NULL,
  fact_type  TEXT         NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE public.persona_facts ENABLE ROW LEVEL SECURITY;
DROP   POLICY IF EXISTS persona_facts_own ON public.persona_facts;
CREATE POLICY persona_facts_own ON public.persona_facts FOR ALL USING (auth.uid() = user_id);
