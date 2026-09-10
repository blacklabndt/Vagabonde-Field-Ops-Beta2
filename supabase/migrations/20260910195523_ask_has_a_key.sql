-- Ask (the app-wide assistant) calls the Anthropic API with this key.
-- Edited on the Admin screen beside the KLIPY key; the env secret
-- ANTHROPIC_API_KEY is the fallback only. Read by the browser only for an
-- Admin (app_settings is Admin-only RLS); blanked in every backup
-- (APP_SETTINGS_SECRETS) and skipped by a restore when null.
alter table public.app_settings add column if not exists anthropic_api_key text;
