-- match_patterns RPC: returns top winners + losers for a query embedding,
-- optionally filtered by stage. One round-trip from the edge function.

create or replace function match_patterns(
  query_embedding vector(1024),
  match_stage call_stage default null,
  winners_k int default 5,
  losers_k int default 2
) returns table (
  id uuid,
  pattern_type pattern_type,
  stage call_stage,
  seller_utterance_paraphrase text,
  agent_response text,
  outcome_label outcome_label,
  similarity real
) language sql stable as $$
  (select p.id, p.pattern_type, p.stage, p.seller_utterance_paraphrase,
          p.agent_response, p.outcome_label,
          (1 - (p.embedding <=> query_embedding))::real as similarity
   from patterns p
   where p.outcome_label = 'winning'
     and (match_stage is null or p.stage = match_stage)
   order by p.embedding <=> query_embedding
   limit winners_k)
  union all
  (select p.id, p.pattern_type, p.stage, p.seller_utterance_paraphrase,
          p.agent_response, p.outcome_label,
          (1 - (p.embedding <=> query_embedding))::real as similarity
   from patterns p
   where p.outcome_label = 'losing'
     and (match_stage is null or p.stage = match_stage)
   order by p.embedding <=> query_embedding
   limit losers_k);
$$;

-- Authenticated agents can call this (server-side via service role bypasses anyway,
-- but the live edge function uses the anon key + JWT to enforce per-agent context later).
grant execute on function match_patterns(vector, call_stage, int, int) to authenticated;
grant execute on function match_patterns(vector, call_stage, int, int) to service_role;

-- match_playbook: nearest playbook chunks for a query, optionally by stage.
create or replace function match_playbook(
  query_embedding vector(1024),
  match_stage call_stage default null,
  k int default 2
) returns table (
  id uuid,
  section text,
  objection_label text,
  stage call_stage,
  recommended_response text,
  similarity real
) language sql stable as $$
  select pc.id, pc.section, pc.objection_label, pc.stage, pc.recommended_response,
         (1 - (pc.embedding <=> query_embedding))::real as similarity
  from playbook_chunks pc
  where pc.active = true
    and (match_stage is null or pc.stage = match_stage or pc.stage is null)
  order by pc.embedding <=> query_embedding
  limit k;
$$;

grant execute on function match_playbook(vector, call_stage, int) to authenticated;
grant execute on function match_playbook(vector, call_stage, int) to service_role;
