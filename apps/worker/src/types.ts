export interface D1Result {
  success: boolean;
  meta?: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T extends D1PreparedStatement>(statements: T[]): Promise<D1Result[]>;
}

export interface Bindings {
  DB: D1Database;
  APP_ORIGIN: string;
  RP_ID: string;
  RP_NAME: string;
  BOOTSTRAP_TOKEN: string;
  APP_SESSION_SECRET: string;
  TELEGRAM_BOT_TOKENS: string;
  TELEGRAM_SHARED_CHANNEL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CALLBACK_URL?: string;
  GOOGLE_REGISTRATION_SECRET: string;
  TELEGRAM_LOGIN_CLIENT_ID?: string;
  TELEGRAM_LOGIN_CLIENT_SECRET?: string;
  TELEGRAM_LOGIN_CALLBACK_URL?: string;
  TELEGRAM_REGISTRATION_SECRET?: string;
  SESSION_TTL_SECONDS?: string;
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  status: 'pending' | 'active' | 'disabled';
}

export interface SessionRow extends UserRow {
  session_id: string;
  csrf_hash: string;
  expires_at: string;
}

export interface AuthVariables {
  requestId: string;
  session: SessionRow;
  jsonBody: unknown;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: AuthVariables;
}

export interface UploadRow {
  id: string;
  user_id: string;
  object_id: string;
  status: string;
  chunk_size: number;
  expected_part_count: number;
  idempotency_key: string;
  expires_at: string;
  object_name: string;
  mime: string;
  object_size: number;
  /** Client-asserted object digest; Worker verifies streamed part digests only. */
  object_sha256: string | null;
  object_status: string;
  object_deleted_at: string | null;
  folder_id: string;
  storage_backend?: 'legacy' | 'bot_api';
}

export interface PartRow {
  id: string;
  object_id: string;
  part_no: number;
  size: number;
  sha256: string;
  message_id: string;
  bot_file_id: string | null;
  idempotency_key: string;
  created_at: string;
  bot_index: number;
}
