-- Refactor seller_bucket to match the Price x Motivation 4-bucket grid.
-- Also add separate motivation_score and
-- price_alignment_score so the components can be queried independently.
--
-- Safe drop+recreate because there's no data in call_reviews yet.

drop view if exists agent_scoreboard;
drop table if exists call_reviews;
drop type if exists seller_bucket;

create type seller_bucket as enum (
  'motivated_priced_right',     -- HIGH motivation + price aligned -> lock it up (rare ideal)
  'motivated_priced_high',      -- HIGH motivation + price high   -> navigate, where $$ is made (most common)
  'unmotivated_priced_right',   -- LOW motivation + price aligned -> dig for hidden motivation (<1%)
  'unmotivated_priced_high',    -- LOW motivation + price high    -> walk away, embrace no
  'wrong_number',               -- bad contact
  'unqualified',                -- not the decision maker, can't sell, severe title issue
  'unknown'                     -- call too short / info too sparse to bucket
);

create table call_reviews (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,

  -- Rep scoring
  rep_overall_score real not null check (rep_overall_score >= 0 and rep_overall_score <= 10),
  rep_dimensions jsonb not null,

  -- Seller bucketing (Price x Motivation 2x2 grid)
  seller_bucket seller_bucket not null,
  motivation_score real check (motivation_score is null or (motivation_score >= 0 and motivation_score <= 10)),
  price_alignment_score real check (price_alignment_score is null or (price_alignment_score >= 0 and price_alignment_score <= 10)),
  bucket_confidence real not null check (bucket_confidence >= 0 and bucket_confidence <= 1),
  bucket_rationale text not null,
  recommended_play text not null,         -- "lock_it_up" | "navigate" | "dig_deeper" | "walk_away" | "drop"

  -- Linguistic observations
  linguistic_observations jsonb not null default '{}'::jsonb,

  -- Coaching
  strengths text[] not null default '{}',
  gaps text[] not null default '{}',
  recommended_next_action text not null,

  reviewed_by text not null,
  reviewed_at timestamptz not null default now(),

  unique (call_id)
);

create index call_reviews_bucket_idx on call_reviews(seller_bucket);
create index call_reviews_score_idx on call_reviews(rep_overall_score);
create index call_reviews_call_idx on call_reviews(call_id);
create index call_reviews_motivation_idx on call_reviews(motivation_score) where motivation_score is not null;

alter table call_reviews enable row level security;
create policy "agents read all reviews" on call_reviews for select to authenticated using (true);

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
  count(*) filter (where cr.seller_bucket = 'motivated_priced_right')   as bucket_lock_it_up,
  count(*) filter (where cr.seller_bucket = 'motivated_priced_high')    as bucket_navigate,
  count(*) filter (where cr.seller_bucket = 'unmotivated_priced_right') as bucket_dig_deeper,
  count(*) filter (where cr.seller_bucket = 'unmotivated_priced_high')  as bucket_walk_away,
  count(*) filter (where cr.seller_bucket = 'wrong_number')             as bucket_wrong_number,
  count(*) filter (where cr.seller_bucket = 'unqualified')              as bucket_unqualified
from call_reviews cr
join calls c on c.id = cr.call_id
left join agent_profiles ap on ap.user_id = c.agent_id
group by c.agent_id, ap.display_name;
