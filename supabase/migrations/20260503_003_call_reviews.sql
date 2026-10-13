-- Call review scoring + seller bucketing.
-- Runs in the offline pipeline AFTER transcription and pattern extraction.
-- Powered by Claude Opus 4.6 with the review_call.system.md prompt.

do $$ begin
  create type seller_bucket as enum (
    'hot',           -- motivated + ready to act, contract path
    'warm',          -- motivated, needs nurture, 7-day follow up
    'cold',          -- some interest, distant timeline, drip
    'dead',          -- no motivation, drop from active
    'wrong_number',  -- bad contact, DNC
    'unqualified'    -- not the decision maker, doesn't own, etc.
  );
exception when duplicate_object then null; end $$;

create table if not exists call_reviews (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,

  -- Rep scoring
  rep_overall_score real not null check (rep_overall_score >= 0 and rep_overall_score <= 10),
  -- Per-dimension scores stored as jsonb so we can iterate on the rubric
  -- without schema migrations. Keys: rapport, discovery, anchoring,
  -- objection_handling, close_attempt, confidence, listening.
  rep_dimensions jsonb not null,

  -- Seller bucketing
  seller_bucket seller_bucket not null,
  bucket_confidence real not null check (bucket_confidence >= 0 and bucket_confidence <= 1),
  bucket_rationale text not null,

  -- Linguistic observations (sarcasm, analogies, mannerisms, evasions,
  -- subtle buying signals, red flags). Free-form jsonb keyed by category.
  linguistic_observations jsonb not null default '{}'::jsonb,

  -- Qualitative coaching notes
  strengths text[] not null default '{}',
  gaps text[] not null default '{}',
  recommended_next_action text not null,

  reviewed_by text not null,                 -- model id, e.g. 'claude-opus-4-6'
  reviewed_at timestamptz not null default now(),

  unique (call_id)
);

create index if not exists call_reviews_bucket_idx on call_reviews(seller_bucket);
create index if not exists call_reviews_score_idx on call_reviews(rep_overall_score);
create index if not exists call_reviews_call_idx on call_reviews(call_id);

alter table call_reviews enable row level security;
create policy "agents read all reviews" on call_reviews for select to authenticated using (true);

-- Convenience view: per-agent rolling scoring dashboard
create or replace view agent_scoreboard as
select
  c.agent_id,
  ap.display_name,
  count(cr.id) as reviewed_calls,
  round(avg(cr.rep_overall_score)::numeric, 2) as avg_overall_score,
  round(avg((cr.rep_dimensions->>'rapport')::real)::numeric, 2) as avg_rapport,
  round(avg((cr.rep_dimensions->>'discovery')::real)::numeric, 2) as avg_discovery,
  round(avg((cr.rep_dimensions->>'anchoring')::real)::numeric, 2) as avg_anchoring,
  round(avg((cr.rep_dimensions->>'objection_handling')::real)::numeric, 2) as avg_objection_handling,
  round(avg((cr.rep_dimensions->>'close_attempt')::real)::numeric, 2) as avg_close_attempt,
  round(avg((cr.rep_dimensions->>'confidence')::real)::numeric, 2) as avg_confidence,
  round(avg((cr.rep_dimensions->>'listening')::real)::numeric, 2) as avg_listening,
  count(*) filter (where cr.seller_bucket = 'hot')      as hot_count,
  count(*) filter (where cr.seller_bucket = 'warm')     as warm_count,
  count(*) filter (where cr.seller_bucket = 'cold')     as cold_count,
  count(*) filter (where cr.seller_bucket = 'dead')     as dead_count
from call_reviews cr
join calls c on c.id = cr.call_id
left join agent_profiles ap on ap.user_id = c.agent_id
group by c.agent_id, ap.display_name;
