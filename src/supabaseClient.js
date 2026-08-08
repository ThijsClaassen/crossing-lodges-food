// Real Supabase Auth client (2026-08-08 — Food Stock 3b of the multi-tenant
// rebuild), sitting alongside sb.js's lightweight REST wrapper rather than
// replacing it — sb.js's table calls stay exactly as they are throughout
// App.jsx, they just now attach the logged-in user's session token instead
// of only the anon key (see sb.js), so RLS can actually tell who's asking.
//
// Same project as the other 4 apps (companies/user_companies/RLS helpers
// already exist there from the Finance Dashboard's Phase 1 — confirmed with
// Thijs, 2026-08-08) — same URL/key defaults sb.js already had, kept here so
// there's one source of truth instead of two hardcoded copies.
import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://arrendpmuwdhrfwvokhv.supabase.co'
export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_e5hLLlXWBVV8NkNUAz3Blg_8oMwP3Wt'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
