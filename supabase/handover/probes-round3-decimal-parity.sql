-- Read-only audit parity table. Zero rows means all expected values agree
-- with PostgreSQL numeric rounding. Not executed against live DB here.
with cases(label, q, r, expected) as (values
  ('ordinary half cent', 1.5::numeric, 60.05::numeric, 90.08::numeric),
  ('legacy quantity', 1.2345, 100, 123.45),
  ('legacy rate', 100, 1.234, 123.40),
  ('small quantity', 0.0004, 100, 0.04),
  ('round product only', 2, 1.005, 2.01),
  ('exponent notation', 1e-7, 100000, 0.01),
  ('zero', 0, 60.05, 0.00)
)
select *, round(q*r, 2) as actual from cases
where round(q*r, 2) <> expected;

with cases(value, decimals, expected) as (values
  (1.005::numeric, 2, 1.01::numeric),
  (2.675, 2, 2.68), (1.15, 1, 1.2), (2.25, 2, 2.25)
)
select *, round(value, decimals) as actual from cases
where round(value, decimals) <> expected;
