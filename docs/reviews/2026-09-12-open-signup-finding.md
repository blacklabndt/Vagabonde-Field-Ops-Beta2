# CRITICAL — the live project accepts public signup (12 Sept 2026)

## What was found

`POST /auth/v1/signup` on the live project, with only the publishable key
(`sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg`, which ships inside every
built JS bundle and is readable by anyone who opens the app), creates a real
account and returns an `access_token` in the same response — email
confirmation is off, so no mailbox is needed.

The provisioning trigger then gives that account the Technician preset:

    ["board","job","jha","upload","ticket","mytickets","files","contacts",
     "timesheets","chat"]

`is_staff()` is "at least one tab", so the stranger is staff.

## What the stranger can read (verified live, read-only)

| table | answer |
|---|---|
| `jobs` | every job, number, project, client |
| `clients` | every client, rates, `gst_rate`, minimum callout |
| `contacts` | every client and contractor contact, name + email |
| `profiles` | the whole crew — names, roles, tab access, dosimetry serials, id codes |
| `tickets` | every ticket |

Chat, the files bucket and report upload are behind tabs the preset grants
too. Prices are the one thing withheld (Technician IS a price role, so in fact
`ticket_lines` and the rate card are reachable as well).

## Why the repo's rule did not stop it

CLAUDE.md says accounts are created by the create-user Edge Function "never by
client signUp", and the trigger's role cap (Technician/Helper) is described as
the mitigation. The cap limits the RANK; it does not stop the ACCOUNT. Nothing
in the repo can close this — **signup is an Auth project setting**, and it is
currently on.

## The fix

1. Supabase dashboard → Authentication → Sign In / Providers → Email →
   turn **"Allow new users to sign up"** OFF. create-user uses the service
   key through the admin API and is unaffected.
2. Also turn off anonymous sign-ins if enabled.
3. Lock or delete the two probe accounts left by this test:
   `LANE1 PROBE DELETE ME` and `lane1probe2@seed.vagabonde.ca`
   (Users & access → the row → delete/lock).
4. Rotate nothing — the publishable key is meant to be public; the hole is the
   open door, not the key.

## Verification after the fix

    curl -s -X POST "https://eielmvxzdwwprmmfamlq.supabase.co/auth/v1/signup" \
      -H "apikey: <publishable>" -H "Content-Type: application/json" \
      -d '{"email":"probe@seed.vagabonde.ca","password":"Str0ngPassw0rd!23"}'

must answer a refusal ("Signups not allowed for this instance"), not a token.

## Closed — verified live, 12 Sept 2026

Kyle turned the switch off in the Supabase dashboard. Re-probed with the
publishable key alone:

- `POST /auth/v1/signup` with an email and password → `422 signup_disabled`,
  "Signups not allowed for this instance".
- `POST /auth/v1/signup` with an empty body (the anonymous door) →
  `422 anonymous_provider_disabled`.

Both doors are shut. `create-user` is unaffected: it mints accounts with the
service key, which does not go through the signup endpoint.

Still to do: delete the two probe accounts the hunt left behind —
`LANE1 PROBE DELETE ME` and `lane1probe2@seed.vagabonde.ca` — once the
signed-in lanes finish (lane1probe2 is the hunt's Technician account).
