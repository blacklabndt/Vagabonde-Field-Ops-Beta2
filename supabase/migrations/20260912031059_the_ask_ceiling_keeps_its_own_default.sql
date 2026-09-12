-- The Ask ceiling keeps its own default
--
-- `add column if not exists ... default` does NOTHING AT ALL when the column
-- is already there — not even the default. 20260912025816 added
-- `ask_daily_token_cap` with no default and seeded the live row with an
-- UPDATE; 20260912030901 was the same migration with the default moved onto
-- the column, and because the column existed by then its whole statement was
-- skipped. So the live row held 10,000,000 and the column held no default,
-- which is the worst of the two: the live project looked right while a fresh
-- replay — the disaster-recovery project, the one that matters — would have
-- inserted its first app_settings row with a null cap and given the assistant
-- no ceiling at all. 20260910023039 exists for the same mistake, one column
-- over.
--
-- This sets the default on its own, which `alter column` does unconditionally.
-- Null stays no ceiling: the default decides what a row that never names the
-- column gets, and says nothing about a row where an Admin has cleared it.
alter table public.app_settings
  alter column ask_daily_token_cap set default 10000000;
