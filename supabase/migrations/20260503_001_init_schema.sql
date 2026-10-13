-- Talkr initial schema
-- Run order: 001 (this file) -> 002 (match_patterns RPC)

-- ============================================================================
-- Extensions
-- ============================================================================
create extension if not exists pgvector with schema public;
create extension if not exists pg_trgm with schema public;
create extension if not exists pgcrypto with schema public;

-- ============================================================================
-- Enums
-- ============================================================================
do $$ begin
  create type outcome_status as enum (
    'contract','callback','dead','voicemail','unqualified','in_progress','dnc','wrong_number'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type pattern_type as enum (
    'objection','hesitation','buying_signal','agent_response','close_attempt','rapport'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type call_stage as enum (
    'opener','qualifier','motivation','condition','price','close','post_close'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type outcome_label as enum ('winning','losing','neutral');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- agent_profiles
-- ============================================================================
create table if not exists agent_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  smrtphone_user_id text,
  podio_user_id text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- calls
-- ============================================================================
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  smrtphone_call_id text not null unique,
  agent_id uuid references agent_profiles(user_id),
  contact_phone text not null,
  contact_id text,
  direction text check (direction in ('outbound','inbound')),
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_seconds int,
  recording_storage_path text,
  raw_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists calls_phone_idx on calls(contact_phone);
create index if not exists calls_started_idx on calls(started_at desc);
create index if not exists calls_agent_idx on calls(agent_id);

-- ============================================================================
-- transcripts
-- ============================================================================
create table if not exists transcripts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  provider text not null default 'deepgram',
  model text not null,
  diarization_version text,
  segments jsonb not null,
  full_text text not null,
  created_at timestamptz not null default now()
);
create index if not exists transcripts_call_idx on transcripts(call_id);
create index if not exists transcripts_full_text_trgm on transcripts using gin (full_text gin_trgm_ops);

-- ============================================================================
-- outcomes
-- ============================================================================
create table if not exists outcomes (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  source text not null check (source in ('podio','manual','smrtphone')),
  status outcome_status not null,
  deal_value_cents bigint,
  podio_item_id text,
  notes text,
  fetched_at timestamptz not null default now(),
  unique (call_id, source)
);
create index if not exists outcomes_status_idx on outcomes(status);

-- ============================================================================
-- patterns
-- ============================================================================
create table if not exists patterns (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  pattern_type pattern_type not null,
  stage call_stage not null,
  seller_utterance text,
  seller_utterance_paraphrase text,
  agent_response text,
  agent_response_quality text check (agent_response_quality in ('won','lost','neutral')),
  outcome_label outcome_label not null,
  confidence real not null,
  tags text[] not null default '{}',
  embedding vector(1024) not null,
  extracted_by text not null,
  extracted_at timestamptz not null default now()
);
create index if not exists patterns_stage_idx on patterns(stage, outcome_label);
create index if not exists patterns_type_idx on patterns(pattern_type, outcome_label);
create index if not exists patterns_tags_gin on patterns using gin (tags);
create index if not exists patterns_call_idx on patterns(call_id);
create index if not exists patterns_embedding_hnsw on patterns
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ============================================================================
-- playbook_chunks
-- ============================================================================
create table if not exists playbook_chunks (
  id uuid primary key default gen_random_uuid(),
  source_doc text not null,
  section text not null,
  objection_label text,
  stage call_stage,
  recommended_response text not null,
  embedding vector(1024) not null,
  version int not null default 1,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create index if not exists playbook_active_idx on playbook_chunks(active, stage);
create index if not exists playbook_embedding_hnsw on playbook_chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ============================================================================
-- live_sessions
-- ============================================================================
create table if not exists live_sessions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agent_profiles(user_id),
  call_id uuid references calls(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  raw_smrtphone_call_id text
);
create index if not exists live_sessions_agent_idx on live_sessions(agent_id, started_at desc);

-- ============================================================================
-- live_suggestions
-- ============================================================================
create table if not exists live_suggestions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references live_sessions(id) on delete cascade,
  emitted_at timestamptz not null default now(),
  seller_utterance text not null,
  retrieved_pattern_ids uuid[] not null default '{}',
  detected_stage call_stage,
  prompt_tokens int,
  completion_tokens int,
  cached_input_tokens int,
  suggestion text not null,
  model text not null,
  end_to_end_latency_ms int,
  ttft_ms int,
  agent_action text check (agent_action in ('used','partial','dismissed','wrong'))
);
create index if not exists live_suggestions_session_idx on live_suggestions(session_id, emitted_at);
create index if not exists live_suggestions_action_idx on live_suggestions(agent_action) where agent_action is not null;

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table agent_profiles enable row level security;
alter table calls enable row level security;
alter table transcripts enable row level security;
alter table outcomes enable row level security;
alter table patterns enable row level security;
alter table playbook_chunks enable row level security;
alter table live_sessions enable row level security;
alter table live_suggestions enable row level security;

-- All authenticated agents can read everything (small team, shared knowledge base)
create policy "agents read all calls" on calls for select to authenticated using (true);
create policy "agents read all transcripts" on transcripts for select to authenticated using (true);
create policy "agents read all outcomes" on outcomes for select to authenticated using (true);
create policy "agents read all patterns" on patterns for select to authenticated using (true);
create policy "agents read all playbook" on playbook_chunks for select to authenticated using (true);

-- Agents read/write only their own sessions and suggestions
create policy "agents read own sessions" on live_sessions for select to authenticated using (agent_id = auth.uid());
create policy "agents insert own sessions" on live_sessions for insert to authenticated with check (agent_id = auth.uid());
create policy "agents update own sessions" on live_sessions for update to authenticated using (agent_id = auth.uid());

create policy "agents read own suggestions" on live_suggestions for select to authenticated
  using (session_id in (select id from live_sessions where agent_id = auth.uid()));
create policy "agents insert own suggestions" on live_suggestions for insert to authenticated
  with check (session_id in (select id from live_sessions where agent_id = auth.uid()));
create policy "agents update own suggestions" on live_suggestions for update to authenticated
  using (session_id in (select id from live_sessions where agent_id = auth.uid()));

create policy "agents read own profile" on agent_profiles for select to authenticated using (user_id = auth.uid());
create policy "agents update own profile" on agent_profiles for update to authenticated using (user_id = auth.uid());

-- Service role bypasses RLS automatically; ingest workers use the service role key.
