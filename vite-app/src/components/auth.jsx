import { useState, useEffect } from "react";
import { sbClient, forgetStoredSession } from "../config.js";
import { tabList, Blueprint, Btn, Field, ErrorBox } from "./common.jsx";
import { OfflineCache } from "../offlineCache.js";
import { OfflineQueue } from "../offlineQueue.js";
import { IDENTITY_KEY } from "../session.js";
import { Recovery } from "../recovery.js";

// `notice` is what the boot has to say about why it landed them here rather
// than opening the app — see App.jsx's bootSession. Shown beside the reset
// link's own complaint, since both are about how they arrived at this screen.
export function SignInScreen({ onSignIn, notice = "" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetState, setResetState] = useState("idle"); // idle | sending | sent
  // Read at module load, before anything could clear the hash: a reset link
  // that has expired or already been used comes back here as an error in the
  // URL and nothing else, and this screen used to answer it in silence.
  const [linkError] = useState(Recovery.error);
  useEffect(() => {
    if (!linkError) return;
    // Said out loud now, so take it out of the address bar — a reload
    // shouldn't bring the same dead link's complaint back with it.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [linkError]);

  // The reset email carries a link back to this app; opening it starts a
  // recovery session, which App.jsx catches and answers with the
  // set-a-new-password screen. Uses whatever is typed in the email field —
  // the link is only ever mailed to the account's own address, so there is
  // nothing to leak by asking.
  const forgotPassword = async e => {
    e.preventDefault();
    if (resetState === "sending") return;
    const addr = email.trim();
    if (!addr) {
      setError("Type your email above first, then tap Forgot password.");
      return;
    }
    setError("");
    setResetState("sending");
    const { error: resetErr } = await sbClient.auth.resetPasswordForEmail(addr, {
      redirectTo: window.location.origin
    });
    if (resetErr) {
      setResetState("idle");
      // Supabase rate-limits these hard (a couple per hour per address) —
      // the likeliest failure, and "try later" is the honest advice for it.
      setError(resetErr.message || "Couldn't send the reset email — wait a few minutes and try again.");
      return;
    }
    setResetState("sent");
  };

  const submit = async e => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const { data, error: authErr } = await sbClient.auth.signInWithPassword({
      email: email.trim(), password
    });
    if (authErr || !data.user) {
      setBusy(false);
      // A request that never reached Supabase is not a wrong password, and
      // this is the screen where confusing the two costs the most: a tech on
      // a lease reads "that password doesn't match", taps Forgot password —
      // which needs the network too and also fails — and decides the account
      // is broken. auth-js reports a request it could not make as
      // AuthRetryableFetchError; the profile read below draws exactly the
      // same distinction one branch further on, for the same reason.
      const noSignal = authErr
        && (authErr.name === "AuthRetryableFetchError" || OfflineQueue.isNetworkError(authErr));
      setError(noSignal
        ? "No connection, so this sign-in couldn't be checked. Signing in needs signal — get back in range and try again."
        : "That email and password don't match an account.");
      return;
    }
    let profile = null, profErr = null;
    try {
      const res = await sbClient.from("profiles").select("*").eq("id", data.user.id).single();
      profile = res.data; profErr = res.error;
    } catch (e) { profErr = e; }
    setBusy(false);
    // A dropped request is not a missing account. .single() reports a
    // genuinely-absent row as PGRST116; anything else — a timeout, an RLS
    // hiccup, a 5xx, a thrown network error on this flaky field link — is a
    // transient failure, and telling a correctly-provisioned tech to "ask an
    // admin" sends them chasing a problem that isn't theirs.
    if (profErr && profErr.code !== "PGRST116") {
      setError("Signed in, but couldn't load your profile just now — check your connection and try again.");
      return;
    }
    if (!profile) {
      setError("Signed in, but no profile is set up for this account yet — ask an admin to add you in Users & access.");
      // Same as the no-tabs branch below: an account the app has judged
      // unusable must not leave a live session on a shared tablet — and a
      // signOut that answered with an error left one, so the stored session
      // is removed by hand. See forgetStoredSession.
      { const { error: outErr } = await sbClient.auth.signOut(); if (outErr) forgetStoredSession(); }
      return;
    }
    const tabs = tabList(profile.tab_access);
    if (!tabs.length) {
      setError("This account has no screens enabled yet — ask an admin to grant access in Users & access.");
      { const { error: outErr } = await sbClient.auth.signOut(); if (outErr) forgetStoredSession(); }
      return;
    }
    const identity = { id: profile.id, name: profile.name, email: data.user.email, role: profile.role, cert: profile.cert, tabs };
    // The door this device's remembered data is protected at. Signing in as
    // anyone but its last owner empties it first — the previous crew's jobs,
    // rates and half-entered tickets are not this signer's to read offline.
    // Signing back in as the same person keeps all of it, which is the point:
    // a lapsed session removes the remembered identity but leaves the work.
    try { await OfflineCache.claimFor(profile.id); }
    catch (e) {
      // A store that would not empty still holds the last crew's jobs, rates
      // and half-entered tickets. Signing in over it used to go ahead anyway
      // — "nobody is trapped because IndexedDB is wedged" — which put this
      // person's name on somebody else's work and handed it to them the
      // moment the signal dropped. The session ends here instead: claimFor
      // records no owner when the clear fails, so trying again clears from
      // scratch, and a device that never clears is one to take out of the
      // truck rather than one to sign in on.
      console.error("Couldn't clear the previous account's cached data:", e);
      setError("This device couldn't clear the previous person's data — try again.");
      { const { error: outErr } = await sbClient.auth.signOut(); if (outErr) forgetStoredSession(); }
      // The remembered identity is the last owner's, and the store still
      // holds their work: leaving it here means the next start without
      // signal opens the app as them for whoever is now holding the tablet.
      // The boot's own claim-failed branch removes it for the same reason.
      try { await OfflineCache.remove(IDENTITY_KEY); } catch (e2) { console.error("Couldn't forget this device's remembered identity:", e2); }
      return;
    }
    // Remembered so the next start with no signal knows who this is, rather
    // than showing a sign-in form that cannot reach the server anyway.
    OfflineCache.put(IDENTITY_KEY, identity);
    onSignIn(identity);
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "40px 24px" }}>
      <div style={{ width: "min(760px,100%)", display: "grid", gridTemplateColumns: "1fr 340px", gap: 40, alignItems: "center" }} className="grid-2col">
        <div>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 34, letterSpacing: "-0.01em", marginBottom: 10 }}>
            VagaboNDE
          </div>
          <div className="kicker" style={{ marginBottom: 18 }}>Field Ops · RT Weld Inspection</div>
          <p style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", maxWidth: "38ch" }}>
            Hazard assessments, radiographic reports and daily billing for crews working out of Grande Prairie. Sign in with your company email.
          </p>
          {/* 65%, not 50%: at half strength this line was 3.15:1 on the light
              theme's paper ground, which is under AA and is the theme a crew
              picks outdoors. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 20, fontSize: 12, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            <span>No account yet? Ask an admin to add you from Users &amp; access —</span>
            <span>accounts are created in Supabase Auth, not self-serve signup.</span>
          </div>
        </div>

        {/* A real <form>, so Enter submits and password managers recognise the
            pair — neither worked when this was two loose inputs. */}
        <Blueprint as="form" onSubmit={submit} style={{ padding: "22px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <h4 style={{ margin: 0, fontSize: 20 }}>Sign in</h4>
          {/* Why they landed back on the sign-in screen instead of the
              set-a-new-password one. Above the fields, not beside the
              button, because it is about the link they just followed. */}
          {linkError && <ErrorBox>{linkError}</ErrorBox>}
          {notice && <ErrorBox>{notice}</ErrorBox>}
          {/* Correcting a typo clears the complaint about it. Left standing,
              "that email and password don't match" sat there while the email
              was retyped and only went on the next submit, which reads as the
              app not having noticed. */}
          <Field label="Email">
            <input className="input" style={{ minHeight: 42 }} type="email" value={email}
              name="email" autoComplete="username" required
              onChange={e => { setEmail(e.target.value); setError(""); }} placeholder="you@vagabonde.ca" />
          </Field>
          <Field label="Password">
            <input className="input" style={{ minHeight: 42 }} type="password" value={password}
              name="password" autoComplete="current-password" required
              onChange={e => { setPassword(e.target.value); setError(""); }} placeholder="••••••••" />
          </Field>
          <ErrorBox>{error}</ErrorBox>
          <Btn type="submit" variant="primary" block style={{ minHeight: 48 }} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Btn>
          {/* This used to read "Offline sign-in cached for 12 h", which
              promises the one thing that cannot happen: the password is
              checked by Supabase, so signing in needs a connection. What is
              cached for twelve hours is the session afterwards — the app
              opens as you, out of range, until then. Saying it the short way
              invited the attempt that fails. */}
          <div style={{ fontSize: 11, marginTop: 4, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            Signing in needs a connection. Once you're in, this device keeps you signed in with no signal for 12 h.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            {resetState === "sent"
              ? <span>Reset link sent — check that inbox</span>
              : <a href="#" onClick={forgotPassword}>{resetState === "sending" ? "Sending…" : "Forgot password"}</a>}
          </div>
        </Blueprint>
      </div>
    </div>
  );
}


// Where the reset email's link lands. The link signs the person in for one
// recovery session; without this screen that session would just open the
// app and they'd still be locked out next time. App.jsx shows this over
// everything when the recovery session starts; Save writes the new
// password onto the account they're now (temporarily) signed in as.
export function SetNewPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async e => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    if (password.length < 8) { setError("Use at least 8 characters."); return; }
    if (password !== again) { setError("The two passwords don't match."); return; }
    setBusy(true);
    setError("");
    const { error: updErr } = await sbClient.auth.updateUser({ password });
    setBusy(false);
    if (updErr) {
      setError(updErr.message || "Couldn't set the new password — try again.");
      return;
    }
    onDone(true);
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "40px 24px" }}>
      <Blueprint as="form" onSubmit={save} style={{ width: "min(380px,100%)", padding: "22px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 19 }}>Set a new password</h3>
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
          You followed a reset link, so you're signed in just long enough to choose a new password.
        </div>
        <Field label="New password">
          <input className="input" type="password" autoComplete="new-password" value={password}
            onChange={e => { setPassword(e.target.value); setError(""); }} style={{ width: "100%" }} />
        </Field>
        <Field label="Same again">
          <input className="input" type="password" autoComplete="new-password" value={again}
            onChange={e => { setAgain(e.target.value); setError(""); }} style={{ width: "100%" }} />
        </Field>
        <ErrorBox>{error}</ErrorBox>
        <Btn type="submit" variant="primary" block style={{ minHeight: 44 }} disabled={busy}>
          {busy ? "Saving…" : "Save new password"}
        </Btn>
        <Btn variant="ghost" block onClick={e => { e.preventDefault(); onDone(false); }}>
          Keep my old password
        </Btn>
      </Blueprint>
    </div>
  );
}
