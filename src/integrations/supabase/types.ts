export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      canonical_categories: {
        Row: {
          created_at: string
          error_message: string | null
          exclude: boolean
          external_id: string
          id: string
          merge_into: string | null
          name: string
          parent_external_id: string | null
          project_id: string
          shopify_collection_id: string | null
          shopify_tag: string | null
          slug: string | null
          status: Database["public"]["Enums"]["canonical_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          exclude?: boolean
          external_id: string
          id?: string
          merge_into?: string | null
          name: string
          parent_external_id?: string | null
          project_id: string
          shopify_collection_id?: string | null
          shopify_tag?: string | null
          slug?: string | null
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          exclude?: boolean
          external_id?: string
          id?: string
          merge_into?: string | null
          name?: string
          parent_external_id?: string | null
          project_id?: string
          shopify_collection_id?: string | null
          shopify_tag?: string | null
          slug?: string | null
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "canonical_categories_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      canonical_customers: {
        Row: {
          created_at: string
          data: Json
          error_message: string | null
          external_id: string
          id: string
          project_id: string
          shopify_id: string | null
          status: Database["public"]["Enums"]["canonical_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          data: Json
          error_message?: string | null
          external_id: string
          id?: string
          project_id: string
          shopify_id?: string | null
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          data?: Json
          error_message?: string | null
          external_id?: string
          id?: string
          project_id?: string
          shopify_id?: string | null
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "canonical_customers_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      canonical_orders: {
        Row: {
          created_at: string
          data: Json
          error_message: string | null
          external_id: string
          id: string
          project_id: string
          shopify_id: string | null
          status: Database["public"]["Enums"]["canonical_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          data: Json
          error_message?: string | null
          external_id: string
          id?: string
          project_id: string
          shopify_id?: string | null
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          data?: Json
          error_message?: string | null
          external_id?: string
          id?: string
          project_id?: string
          shopify_id?: string | null
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "canonical_orders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      canonical_pages: {
        Row: {
          created_at: string
          data: Json
          error_message: string | null
          external_id: string
          id: string
          project_id: string
          shopify_id: string | null
          status: Database["public"]["Enums"]["canonical_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          data: Json
          error_message?: string | null
          external_id: string
          id?: string
          project_id: string
          shopify_id?: string | null
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          data?: Json
          error_message?: string | null
          external_id?: string
          id?: string
          project_id?: string
          shopify_id?: string | null
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "canonical_pages_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      canonical_products: {
        Row: {
          created_at: string
          data: Json
          error_message: string | null
          external_id: string
          id: string
          project_id: string
          shopify_id: string | null
          status: Database["public"]["Enums"]["canonical_status"]
          updated_at: string
          upload_lock_id: string | null
          upload_locked_at: string | null
          upload_locked_until: string | null
        }
        Insert: {
          created_at?: string
          data: Json
          error_message?: string | null
          external_id: string
          id?: string
          project_id: string
          shopify_id?: string | null
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
          upload_lock_id?: string | null
          upload_locked_at?: string | null
          upload_locked_until?: string | null
        }
        Update: {
          created_at?: string
          data?: Json
          error_message?: string | null
          external_id?: string
          id?: string
          project_id?: string
          shopify_id?: string | null
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
          upload_lock_id?: string | null
          upload_locked_at?: string | null
          upload_locked_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "canonical_products_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      job_errors: {
        Row: {
          created_at: string
          entity_external_id: string
          entity_type: Database["public"]["Enums"]["entity_type"]
          error_message: string
          id: string
          job_id: string
          raw_data: Json | null
        }
        Insert: {
          created_at?: string
          entity_external_id: string
          entity_type: Database["public"]["Enums"]["entity_type"]
          error_message: string
          id?: string
          job_id: string
          raw_data?: Json | null
        }
        Update: {
          created_at?: string
          entity_external_id?: string
          entity_type?: Database["public"]["Enums"]["entity_type"]
          error_message?: string
          id?: string
          job_id?: string
          raw_data?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "job_errors_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          entity_type: Database["public"]["Enums"]["entity_type"]
          error_count: number | null
          error_log_url: string | null
          id: string
          processed_count: number | null
          progress_percent: number | null
          project_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          total_count: number | null
          type: Database["public"]["Enums"]["job_type"]
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          entity_type: Database["public"]["Enums"]["entity_type"]
          error_count?: number | null
          error_log_url?: string | null
          id?: string
          processed_count?: number | null
          progress_percent?: number | null
          project_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          total_count?: number | null
          type: Database["public"]["Enums"]["job_type"]
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          entity_type?: Database["public"]["Enums"]["entity_type"]
          error_count?: number | null
          error_log_url?: string | null
          id?: string
          processed_count?: number | null
          progress_percent?: number | null
          project_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          total_count?: number | null
          type?: Database["public"]["Enums"]["job_type"]
        }
        Relationships: [
          {
            foreignKeyName: "jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      mapping_profiles: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          mappings: Json
          name: string
          project_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          mappings?: Json
          name: string
          project_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          mappings?: Json
          name?: string
          project_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mapping_profiles_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      price_periods: {
        Row: {
          created_at: string
          disabled: boolean
          end_date: string | null
          id: string
          period_id: string
          project_id: string
          start_date: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          disabled?: boolean
          end_date?: string | null
          id?: string
          period_id: string
          project_id: string
          start_date?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          disabled?: boolean
          end_date?: string | null
          id?: string
          period_id?: string
          project_id?: string
          start_date?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_periods_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      project_files: {
        Row: {
          created_at: string
          entity_type: string
          error_message: string | null
          file_name: string
          file_size: number | null
          id: string
          project_id: string
          row_count: number | null
          status: string
          storage_path: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          entity_type: string
          error_message?: string | null
          file_name: string
          file_size?: number | null
          id?: string
          project_id: string
          row_count?: number | null
          status?: string
          storage_path: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          entity_type?: string
          error_message?: string | null
          file_name?: string
          file_size?: number | null
          id?: string
          project_id?: string
          row_count?: number | null
          status?: string
          storage_path?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_files_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_redirects: {
        Row: {
          ai_suggestions: Json | null
          confidence_score: number | null
          created_at: string
          entity_id: string
          entity_type: string
          error_message: string | null
          id: string
          matched_by: string | null
          new_path: string
          old_path: string
          project_id: string
          shopify_redirect_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          ai_suggestions?: Json | null
          confidence_score?: number | null
          created_at?: string
          entity_id: string
          entity_type: string
          error_message?: string | null
          id?: string
          matched_by?: string | null
          new_path: string
          old_path: string
          project_id: string
          shopify_redirect_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          ai_suggestions?: Json | null
          confidence_score?: number | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          error_message?: string | null
          id?: string
          matched_by?: string | null
          new_path?: string
          old_path?: string
          project_id?: string
          shopify_redirect_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_redirects_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          category_count: number | null
          created_at: string
          customer_count: number | null
          dandomain_api_key_encrypted: string | null
          dandomain_base_url: string | null
          dandomain_shop_url: string | null
          id: string
          name: string
          order_count: number | null
          page_count: number | null
          product_count: number | null
          shopify_access_token_encrypted: string | null
          shopify_store_domain: string | null
          status: Database["public"]["Enums"]["project_status"]
          updated_at: string
          uploads_paused: boolean
          user_id: string
        }
        Insert: {
          category_count?: number | null
          created_at?: string
          customer_count?: number | null
          dandomain_api_key_encrypted?: string | null
          dandomain_base_url?: string | null
          dandomain_shop_url?: string | null
          id?: string
          name: string
          order_count?: number | null
          page_count?: number | null
          product_count?: number | null
          shopify_access_token_encrypted?: string | null
          shopify_store_domain?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          updated_at?: string
          uploads_paused?: boolean
          user_id: string
        }
        Update: {
          category_count?: number | null
          created_at?: string
          customer_count?: number | null
          dandomain_api_key_encrypted?: string | null
          dandomain_base_url?: string | null
          dandomain_shop_url?: string | null
          id?: string
          name?: string
          order_count?: number | null
          page_count?: number | null
          product_count?: number | null
          shopify_access_token_encrypted?: string | null
          shopify_store_domain?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          updated_at?: string
          uploads_paused?: boolean
          user_id?: string
        }
        Relationships: []
      }
      upload_jobs: {
        Row: {
          batch_size: number
          completed_at: string | null
          created_at: string
          current_batch: number
          duplicate_cache: Json | null
          entity_type: string
          error_count: number
          error_details: Json | null
          id: string
          is_test_mode: boolean
          items_per_minute: number | null
          last_batch_duration_ms: number | null
          last_batch_items: number | null
          last_batch_speed: number | null
          last_bucket_used: number | null
          last_heartbeat_at: string | null
          lookup_cache: Json | null
          lookup_cache_built_at: string | null
          next_attempt_at: string | null
          prepare_offset: number
          processed_count: number
          project_id: string
          skipped_count: number
          started_at: string | null
          status: string
          total_count: number
          trigger_mode: string
          updated_at: string
          worker_lock_id: string | null
          worker_locked_until: string | null
        }
        Insert: {
          batch_size?: number
          completed_at?: string | null
          created_at?: string
          current_batch?: number
          duplicate_cache?: Json | null
          entity_type: string
          error_count?: number
          error_details?: Json | null
          id?: string
          is_test_mode?: boolean
          items_per_minute?: number | null
          last_batch_duration_ms?: number | null
          last_batch_items?: number | null
          last_batch_speed?: number | null
          last_bucket_used?: number | null
          last_heartbeat_at?: string | null
          lookup_cache?: Json | null
          lookup_cache_built_at?: string | null
          next_attempt_at?: string | null
          prepare_offset?: number
          processed_count?: number
          project_id: string
          skipped_count?: number
          started_at?: string | null
          status?: string
          total_count?: number
          trigger_mode?: string
          updated_at?: string
          worker_lock_id?: string | null
          worker_locked_until?: string | null
        }
        Update: {
          batch_size?: number
          completed_at?: string | null
          created_at?: string
          current_batch?: number
          duplicate_cache?: Json | null
          entity_type?: string
          error_count?: number
          error_details?: Json | null
          id?: string
          is_test_mode?: boolean
          items_per_minute?: number | null
          last_batch_duration_ms?: number | null
          last_batch_items?: number | null
          last_batch_speed?: number | null
          last_bucket_used?: number | null
          last_heartbeat_at?: string | null
          lookup_cache?: Json | null
          lookup_cache_built_at?: string | null
          next_attempt_at?: string | null
          prepare_offset?: number
          processed_count?: number
          project_id?: string
          skipped_count?: number
          started_at?: string | null
          status?: string
          total_count?: number
          trigger_mode?: string
          updated_at?: string
          worker_lock_id?: string | null
          worker_locked_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "upload_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      watchdog_state: {
        Row: {
          id: string
          last_execution_at: string
        }
        Insert: {
          id?: string
          last_execution_at?: string
        }
        Update: {
          id?: string
          last_execution_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      count_primary_products: {
        Args: { p_project_id: string }
        Returns: {
          primary_count: number
          status: string
        }[]
      }
    }
    Enums: {
      canonical_status:
        | "pending"
        | "mapped"
        | "uploaded"
        | "failed"
        | "duplicate"
      entity_type: "products" | "customers" | "orders" | "categories" | "pages"
      job_status: "pending" | "running" | "completed" | "failed" | "cancelled"
      job_type: "extract" | "normalize" | "upload"
      project_status:
        | "draft"
        | "connected"
        | "extracted"
        | "mapped"
        | "migrating"
        | "completed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      canonical_status: [
        "pending",
        "mapped",
        "uploaded",
        "failed",
        "duplicate",
      ],
      entity_type: ["products", "customers", "orders", "categories", "pages"],
      job_status: ["pending", "running", "completed", "failed", "cancelled"],
      job_type: ["extract", "normalize", "upload"],
      project_status: [
        "draft",
        "connected",
        "extracted",
        "mapped",
        "migrating",
        "completed",
      ],
    },
  },
} as const
