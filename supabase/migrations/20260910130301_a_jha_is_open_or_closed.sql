-- A JHA is Open or Closed, and the table says so.
--
-- jhas.status has been NOT NULL with a default of 'Open' since the baseline,
-- but it was the one status column of five with no check list: jobs,
-- tickets, equipment and backup_runs each name their states in a CHECK, and
-- a JHA could be filed as anything a typo or a future write chose — neither
-- open (Job detail's close-out button asks for 'Open') nor closed (the
-- rendered assessment asks for 'Closed'), an assessment no screen would ever
-- show as either. The app writes only the two; every row live holds one of
-- the two (Open 5, Closed 8 on 10 Sept 2026), so the constraint validates
-- against the table as it stands.
alter table public.jhas
  add constraint jhas_status_check check (status in ('Open', 'Closed'));
