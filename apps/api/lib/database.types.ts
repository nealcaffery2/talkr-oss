// Auto-generated from Supabase schema via MCP. Re-run: see scripts/regen-types.ts
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_profiles: {
        Row: {
          created_at: string
          display_name: string
          podio_user_id: string | null
          smrtphone_user_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name: string
          podio_user_id?: string | null
          smrtphone_user_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string
          podio_user_id?: string | null
          smrtphone_user_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      call_reviews: {
        Row: {
          bucket_confidence: number
          bucket_rationale: string
          call_id: string
          gaps: string[]
          id: string
          linguistic_observations: Json
          motivation_score: number | null
          price_alignment_score: number | null
          recommended_next_action: string
          recommended_play: string
          rep_dimensions: Json
          rep_overall_score: number
          reviewed_at: string
          reviewed_by: string
          seller_bucket: Database["public"]["Enums"]["seller_bucket"]
          strengths: string[]
        }
        Insert: {
          bucket_confidence: number
          bucket_rationale: string
          call_id: string
          gaps?: string[]
          id?: string
          linguistic_observations?: Json
          motivation_score?: number | null
          price_alignment_score?: number | null
          recommended_next_action: string
          recommended_play: string
          rep_dimensions: Json
          rep_overall_score: number
          reviewed_at?: string
          reviewed_by: string
          seller_bucket: Database["public"]["Enums"]["seller_bucket"]
          strengths?: string[]
        }
        Update: Partial<Database["public"]["Tables"]["call_reviews"]["Insert"]>
        Relationships: []
      }
      calls: {
        Row: {
          agent_id: string | null
          contact_id: string | null
          contact_phone: string
          created_at: string
          direction: string | null
          duration_seconds: number | null
          ended_at: string | null
          id: string
          raw_metadata: Json
          recording_storage_path: string | null
          smrtphone_call_id: string
          started_at: string
        }
        Insert: {
          agent_id?: string | null
          contact_id?: string | null
          contact_phone: string
          created_at?: string
          direction?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          raw_metadata?: Json
          recording_storage_path?: string | null
          smrtphone_call_id: string
          started_at: string
        }
        Update: Partial<Database["public"]["Tables"]["calls"]["Insert"]>
        Relationships: []
      }
      outcomes: {
        Row: {
          call_id: string
          deal_value_cents: number | null
          fetched_at: string
          id: string
          notes: string | null
          podio_item_id: string | null
          source: string
          status: Database["public"]["Enums"]["outcome_status"]
        }
        Insert: {
          call_id: string
          deal_value_cents?: number | null
          fetched_at?: string
          id?: string
          notes?: string | null
          podio_item_id?: string | null
          source: string
          status: Database["public"]["Enums"]["outcome_status"]
        }
        Update: Partial<Database["public"]["Tables"]["outcomes"]["Insert"]>
        Relationships: []
      }
      patterns: {
        Row: {
          agent_response: string | null
          agent_response_quality: string | null
          call_id: string
          confidence: number
          embedding: string
          extracted_at: string
          extracted_by: string
          id: string
          outcome_label: Database["public"]["Enums"]["outcome_label"]
          pattern_type: Database["public"]["Enums"]["pattern_type"]
          seller_utterance: string | null
          seller_utterance_paraphrase: string | null
          stage: Database["public"]["Enums"]["call_stage"]
          tags: string[]
        }
        Insert: {
          agent_response?: string | null
          agent_response_quality?: string | null
          call_id: string
          confidence: number
          embedding: string
          extracted_at?: string
          extracted_by: string
          id?: string
          outcome_label: Database["public"]["Enums"]["outcome_label"]
          pattern_type: Database["public"]["Enums"]["pattern_type"]
          seller_utterance?: string | null
          seller_utterance_paraphrase?: string | null
          stage: Database["public"]["Enums"]["call_stage"]
          tags?: string[]
        }
        Update: Partial<Database["public"]["Tables"]["patterns"]["Insert"]>
        Relationships: []
      }
      playbook_chunks: {
        Row: {
          active: boolean
          embedding: string
          id: string
          objection_label: string | null
          recommended_response: string
          section: string
          source_doc: string
          stage: Database["public"]["Enums"]["call_stage"] | null
          updated_at: string
          version: number
        }
        Insert: {
          active?: boolean
          embedding: string
          id?: string
          objection_label?: string | null
          recommended_response: string
          section: string
          source_doc: string
          stage?: Database["public"]["Enums"]["call_stage"] | null
          updated_at?: string
          version?: number
        }
        Update: Partial<Database["public"]["Tables"]["playbook_chunks"]["Insert"]>
        Relationships: []
      }
      transcripts: {
        Row: {
          call_id: string
          created_at: string
          diarization_version: string | null
          full_text: string
          id: string
          model: string
          provider: string
          segments: Json
        }
        Insert: {
          call_id: string
          created_at?: string
          diarization_version?: string | null
          full_text: string
          id?: string
          model: string
          provider?: string
          segments: Json
        }
        Update: Partial<Database["public"]["Tables"]["transcripts"]["Insert"]>
        Relationships: []
      }
      live_sessions: { Row: any; Insert: any; Update: any; Relationships: [] }
      live_suggestions: { Row: any; Insert: any; Update: any; Relationships: [] }
    }
    Views: {
      agent_scoreboard: {
        Row: {
          agent_id: string | null
          avg_anchoring: number | null
          avg_close_attempt: number | null
          avg_confidence: number | null
          avg_discovery: number | null
          avg_listening: number | null
          avg_objection_handling: number | null
          avg_overall_score: number | null
          avg_rapport: number | null
          bucket_dig_deeper: number | null
          bucket_lock_it_up: number | null
          bucket_navigate: number | null
          bucket_unqualified: number | null
          bucket_walk_away: number | null
          bucket_wrong_number: number | null
          display_name: string | null
          reviewed_calls: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      match_patterns: {
        Args: {
          losers_k?: number
          match_stage?: Database["public"]["Enums"]["call_stage"]
          query_embedding: string
          winners_k?: number
        }
        Returns: {
          agent_response: string
          id: string
          outcome_label: Database["public"]["Enums"]["outcome_label"]
          pattern_type: Database["public"]["Enums"]["pattern_type"]
          seller_utterance_paraphrase: string
          similarity: number
          stage: Database["public"]["Enums"]["call_stage"]
        }[]
      }
      match_playbook: {
        Args: {
          k?: number
          match_stage?: Database["public"]["Enums"]["call_stage"]
          query_embedding: string
        }
        Returns: {
          id: string
          objection_label: string
          recommended_response: string
          section: string
          similarity: number
          stage: Database["public"]["Enums"]["call_stage"]
        }[]
      }
    }
    Enums: {
      call_stage:
        | "opener" | "qualifier" | "motivation" | "condition"
        | "price" | "close" | "post_close"
      outcome_label: "winning" | "losing" | "neutral"
      outcome_status:
        | "contract" | "callback" | "dead" | "voicemail"
        | "unqualified" | "in_progress" | "dnc" | "wrong_number"
      pattern_type:
        | "objection" | "hesitation" | "buying_signal"
        | "agent_response" | "close_attempt" | "rapport"
      seller_bucket:
        | "motivated_priced_right" | "motivated_priced_high"
        | "unmotivated_priced_right" | "unmotivated_priced_high"
        | "wrong_number" | "unqualified" | "unknown"
    }
    CompositeTypes: { [_ in never]: never }
  }
}
