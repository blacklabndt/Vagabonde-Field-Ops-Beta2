import React, { useState, useEffect, useRef } from "react";
import { TABS, CONTEXT_TABS, ROLE_PRESETS, TECH_LEVELS } from "../data.js";
import { Db } from "../db.js";
import { UNIVERSAL_TABS, tabList, Blueprint, Btn, CheckBox, TagX, Field, Dialog, ErrorBox, Switch, emailIn, useMissingFields, SearchSelect, Loading, RequiredLeft } from "./common.jsx";

export function UsersAccessScreen({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(currentUser.id);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Something that went the way it was meant to and still needs saying —
  // an account locked rather than deleted, which is the designed outcome
  // for someone with work on file. It is kept out of `error` because that
  // box is an alert, and announcing a correct outcome as a failure sends
  // the admin looking for something to fix.
  const [note, setNote] = useState("");

  const load = async () => {
    setLoading(true);
    // A read that failed once used to leave its red box up through every
    // later success.
    setError("");
    try { setUsers(await Db.listProfiles()); }
    catch (e) { setError(e.message || "Couldn't load accounts."); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const account = users.find(u => u.id === selected) || users[0];
  // Emailing an account a set-password link (Admin only; the function
  // checks). The note under the button says where it went, or why not,
  // and clears when another account is picked.
  const [resetting, setResetting] = useState(false);
  const [resetNote, setResetNote] = useState("");
  // Both notes name the account they are about, so picking another one is
  // the end of them.
  useEffect(() => { setResetNote(""); setNote(""); }, [selected]);
  const sendReset = async () => {
    if (!account) return;
    if (!confirm(`Email ${account.name} a link to set a new password? The link works once.`)) return;
    setResetting(true);
    setResetNote("");
    try {
      const r = await Db.sendPasswordReset(account.id);
      setResetNote(`Sent to ${r && r.sentTo ? r.sentTo : "their email address"}.`);
    } catch (e) {
      setResetNote(e.message || "Couldn't send the link.");
    }
    setResetting(false);
  };

  // Putting back an account delete-user locked (Admin only; the function
  // checks). It is not destructive, so it is a secondary button — but it is
  // still someone's way back into the app, so it asks first and says who it
  // was about afterwards, in the same note the lock itself uses.
  const [unlocking, setUnlocking] = useState(false);
  const unlockAccount = async () => {
    if (!account) return;
    if (!confirm(`Unlock ${account.displayName}? They can sign in again with their old password and get the ${account.role} preset's screens.`)) return;
    setUnlocking(true);
    setNote("");
    setError("");
    try {
      const res = await Db.unlockUserAccount(account.id);
      // The list is reloaded before the note is written: load() clears the
      // error box on its way past, and the account's own row has to lose its
      // "Locked out" line for the note above it to make sense.
      await load();
      setNote([res && res.message, res && res.warning].filter(Boolean).join(" ") ||
        `${account.displayName} can sign in again.`);
    } catch (e) {
      setError(e.message || "Couldn't unlock that account.");
    }
    setUnlocking(false);
  };

  // Access writes send the whole tab array, so two of them landing out of
  // order would silently restore a tab the admin just removed. This chains
  // every access/role write onto the previous one, so they commit in click
  // order and the database always ends on the last thing the admin did.
  const writeChain = useRef(Promise.resolve());
  const chainWrite = (work, failMsg) => {
    writeChain.current = writeChain.current
      .catch(() => {})
      .then(work)
      .catch(async e => { setError(e.message || failMsg); await load(); });
  };

  const toggleTab = key => {
    if (!account) return;
    if (account.id === currentUser.id && key === "users") return; // can't remove own admin access
    const acctId = account.id;
    const current = tabList(account.tab_access);
    const tabs = current.includes(key) ? current.filter(t => t !== key) : [...current, key];
    setUsers(p => p.map(u => u.id === acctId ? { ...u, tab_access: tabs } : u));
    chainWrite(() => Db.updateProfileTabs(acctId, tabs), "Couldn't update access.");
  };
  // Locking yourself out is a one-way trip: once your row loses the users
  // tab, every policy gated on has_tab('users') denies you, so you cannot
  // grant it back from inside the app. The tab checkboxes already refused
  // this; the role dropdown did not.
  const wouldLockMeOut = tabs => account && account.id === currentUser.id && !tabs.includes("users");

  const setRole = role => {
    if (!account || !ROLE_PRESETS[role]) return;
    // Backed by profiles_update in the database (migration "a permission
    // you have not got"): a role change is an Admin's, and nobody's own —
    // the users tab alone used to be enough to make oneself Admin.
    if (currentUser.role !== "Admin") { setError("Only an Admin can change someone's role."); return; }
    if (account.id === currentUser.id) { setError("Your own role is changed by another admin, not from your own account."); return; }
    const tabs = ROLE_PRESETS[role].slice();
    if (wouldLockMeOut(tabs)) {
      setError(`Switching your own account to ${role} would remove your access to Users & access, and only this screen can give it back. Have another admin change your role, or promote someone else first.`);
      return;
    }
    setError("");
    const acctId = account.id;
    setUsers(p => p.map(u => u.id === acctId ? { ...u, role, tab_access: tabs } : u));
    // Same write chain as toggleTab — a role change and a tab toggle both
    // write tab_access, so they must serialize or race each other.
    chainWrite(() => Db.updateProfileRole(acctId, role, tabs), "Couldn't update role.");
  };
  const resetPreset = async () => {
    if (!account) return;
    const tabs = (ROLE_PRESETS[account.role] || ROLE_PRESETS.Technician).slice();
    if (wouldLockMeOut(tabs)) {
      setError("That preset doesn't include Users & access, so resetting your own account would lock you out of this screen.");
      return;
    }
    // It throws away every tick made by hand on this account, and the only
    // way back is to remember what they were — so it asks, like the other
    // one-tap undoings on this screen.
    if (!confirm(`Reset ${account.displayName}'s access to the ${account.role} preset? Their sections are replaced by that role's defaults — this can't be undone.`)) return;
    setError("");
    const acctId = account.id;
    setUsers(p => p.map(u => u.id === acctId ? { ...u, tab_access: tabs } : u));
    // Through the same chain as every other tab write: a reset landing
    // after a quicker untick used to restore the tab just removed.
    chainWrite(() => Db.updateProfileTabs(acctId, tabs), "Couldn't reset access.");
  };
  const removeAccount = async () => {
    if (!account) return;
    if (account.id === currentUser.id) { setError("You can't remove your own account."); return; }
    setNote("");
    // The red box outlives a change of account on purpose, so the retry has
    // to clear it here: a half-landed lock that finished on the second press
    // left its own "press Remove account again" standing over the note
    // saying it had.
    setError("");
    if (!confirm(`Remove ${account.displayName}'s account? They will no longer be able to sign in — this can't be undone. (An account with tickets or JHAs on file is locked rather than deleted, so the records keep their name.)`)) return;
    try {
      const res = await Db.deleteUserAccount(account.id);
      if (res && res.deactivated) {
        // Locked, not deleted: the row stays, with no tabs and a stamp, so
        // the list shows what happened rather than pretending it vanished.
        setUsers(p => p.map(u => u.id === account.id ? { ...u, tab_access: [], deactivated_at: new Date().toISOString() } : u));
        // A half-landed lock is unfinished work, not news: a note clears on
        // the next account picked, and the panel below then says the account
        // can't sign in — which is exactly the half that did not happen.
        if (res.banFailed) setError(res.message);
        else setNote(res.message || `${account.displayName}'s account was locked instead of deleted: they can no longer sign in.`);
        return;
      }
      setUsers(p => p.filter(u => u.id !== account.id));
      setSelected(currentUser.id);
    }
    catch (e) { setError(e.message || "Couldn't remove that account."); }
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 20 }}>
        <h2 style={{ fontSize: 34, margin: 0 }}>Users &amp; access</h2>
        {/* An Admin's, like the role picker and Remove account below:
            create-user checks the caller's rank itself, so this button was a
            dialog somebody filled in and then had refused. */}
        {currentUser.role === "Admin" && (
          <Btn variant="primary" style={{ marginLeft: "auto" }} onClick={() => setShowNew(true)}>+ New user</Btn>
        )}
      </div>
      <ErrorBox>{error}</ErrorBox>
      {note && (
        <div role="status" style={{ fontSize: 13, marginBottom: 12, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>{note}</div>
      )}

      {loading ? (
        <Loading />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* One searchable picker instead of a rail of every account — the
              crew outgrew a list you could eyeball, per Kyle. It opens on
              your own account, same as the rail's default selection did. */}
          <SearchSelect
            // flex none: the component's default flex-basis is meant for the
            // side-by-side rows it usually sits in — inside this column
            // container it becomes 320px of reserved HEIGHT under the box.
            style={{ maxWidth: 420, flex: "none" }}
            listId="user-picker-list"
            ariaLabel="Search people"
            placeholder={account ? `${account.displayName} — search to change…` : "Search people…"}
            search={text => {
              const q = text.trim().toLowerCase();
              const matched = q
                ? users.filter(u => (u.displayName || "").toLowerCase().includes(q) || (u.role || "").toLowerCase().includes(q))
                : users;
              return { rows: matched.slice(0, 25), total: matched.length };
            }}
            optionKey={u => u.id}
            onPick={u => setSelected(u.id)}
            onError={setError}
            renderOption={u => (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15 }}>
                  <span>{u.displayName}</span>
                  {u.id === currentUser.id && <TagX variant="outline">you</TagX>}
                  {u.is_subcontractor && <TagX variant="neutral">sub</TagX>}
                </div>
                <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{u.role} · {tabList(u.tab_access).length} of {TABS.length} sections</div>
              </>
            )}
          />

          {account && (
            <Blueprint style={{ padding: "18px 20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <h4 style={{ margin: 0, fontSize: 19 }}>{account.displayName}</h4>
                <TagX variant="accent">{account.role}</TagX>
                {account.is_subcontractor && <TagX variant="outline">Subcontractor</TagX>}
              </div>
              <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 16 }}>{account.cert}</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }} className="grid-2col">
                <div>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginBottom: 8 }}>Access</div>
                  <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 10 }}>
                    Most sections appear in the menu when ticked. The ones marked
                    “from a job” never sit in anyone's menu — they open from a
                    job's own page — but the tick still decides whether this
                    account may use them, including uploading the files they
                    produce. Unticking is not a lock on past work: nothing
                    already filed is affected, and ticking it back restores it.
                  </div>
                  {TABS.map(t => {
                    const allowed = tabList(account.tab_access).includes(t.key);
                    const lockedSelf = account.id === currentUser.id && t.key === "users";
                    // Contacts is a plain lookup everyone gets, so its box is
                    // shown ticked and disabled rather than pretending to be a
                    // switch that does nothing.
                    const universal = UNIVERSAL_TABS.includes(t.key);
                    // Contextual screens are permission-only: hidden from every
                    // menu by design after two admins hid them by unticking —
                    // which also, invisibly, revoked their upload rights.
                    const contextual = CONTEXT_TABS.includes(t.key);
                    return (
                      <div key={t.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", opacity: lockedSelf || universal ? 0.55 : 1 }}>
                        <CheckBox on={allowed} size={28} disabled={lockedSelf || universal}
                          label={`${contextual ? "Allow" : "Show"} ${t.label}`} onChange={() => toggleTab(t.key)} />
                        <span style={{ fontSize: 14, flex: 1 }}>
                          {t.label}
                          {contextual && <span style={{ fontSize: 11, marginLeft: 6, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>from a job</span>}
                        </span>
                        <TagX variant={allowed ? "accent" : "outline"}>{universal ? "Everyone" : contextual ? (allowed ? "Allowed" : "Blocked") : (allowed ? "Shown" : "Hidden")}</TagX>
                      </div>
                    );
                  })}
                  {account.id === currentUser.id && <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 6 }}>can't hide Users &amp; access from yourself</div>}
                </div>

                <div>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginBottom: 8 }}>Person</div>
                  <PersonFields key={account.id} account={account} onSaved={load} onError={setError} />

                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", margin: "18px 0 8px" }}>Role</div>
                  <Field label="Role">
                    <select className="input" value={account.role} onChange={e => setRole(e.target.value)}
                      disabled={currentUser.role !== "Admin" || account.id === currentUser.id}
                      aria-label="Role">
                      {Object.keys(ROLE_PRESETS).map(r => <option key={r}>{r}</option>)}
                    </select>
                  </Field>
                  {account.deactivated_at && (
                    <div style={{ fontSize: 12, color: "var(--color-accent-700)", margin: "6px 0 0" }}>
                      Locked out {new Date(account.deactivated_at).toLocaleDateString("en-CA", { day: "2-digit", month: "short", year: "numeric" })} — this account can't sign in. Its name stays on past records.{" "}
                      {currentUser.role === "Admin"
                        ? "“Unlock account” below puts it back: they sign in with the password they had, at the same role, with that role's sections."
                        : "An Admin can put it back from this screen — the person then signs in with the password they had."}
                    </div>
                  )}
                  {currentUser.role === "Admin" && account.id === currentUser.id && (
                    <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", margin: "6px 0 0" }}>your own role is changed by another admin</div>
                  )}
                  <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", margin: "6px 0 10px" }}>
                    {currentUser.role === "Admin"
                      ? "A set-password link goes to the account's email address and lands on the app's own set-password screen — the same one \"Forgot password\" uses. It works once."
                      : "Password resets happen through the \"Forgot password\" flow on the sign-in screen, or an Admin can send a set-password link."}
                  </div>
                  {resetNote && <div style={{ fontSize: 12, margin: "0 0 8px" }}>{resetNote}</div>}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                    {/* First in the stack, because on a locked account it is
                        the only button that does anything the admin came
                        here for. Secondary, not danger: nothing is destroyed. */}
                    {currentUser.role === "Admin" && account.deactivated_at && (
                      <Btn variant="secondary" disabled={unlocking} onClick={unlockAccount}>{unlocking ? "Unlocking…" : "Unlock account"}</Btn>
                    )}
                    {currentUser.role === "Admin" && !account.deactivated_at && (
                      <Btn variant="secondary" disabled={resetting} onClick={sendReset}>{resetting ? "Sending…" : "Email a set-password link"}</Btn>
                    )}
                    <Btn variant="secondary" onClick={resetPreset}>Reset to role preset</Btn>
                    {/* The database rule is an Admin's (profiles_delete, delete-user's
                        own check): the users tab grants tabs, never rank. */}
                    {currentUser.role === "Admin" && (
                      <Btn variant="danger" onClick={removeAccount}>Remove account</Btn>
                    )}
                  </div>
                </div>
              </div>
            </Blueprint>
          )}
        </div>
      )}

      {/* The dialog closes on a created account whether or not everything
          after it landed; anything that didn't is said up here, where it
          stays readable next to the list the admin now has to use. */}
      {/* The list is reloaded first and the warning written after it: load()
          clears the error box on its way past, so the other order left the
          admin with the new account and nothing said about what didn't
          land with it. */}
      {showNew && <NewUserDialog onClose={() => setShowNew(false)} onCreated={async warning => { setShowNew(false); await load(); setError(warning || ""); }} />}
    </div>
  );
}

function PersonFields({ account, onSaved, onError }) {
  const [form, setForm] = useState({
    firstName: account.first_name || "",
    lastName: account.last_name || "",
    cert: account.cert || "",
    level: account.level || "",
    isSubcontractor: !!account.is_subcontractor,
    unitNumber: account.unit_number || "",
    idCode: account.id_code || ""
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const dirty = form.firstName !== (account.first_name || "") ||
    form.lastName !== (account.last_name || "") ||
    form.cert !== (account.cert || "") ||
    form.level !== (account.level || "") ||
    form.isSubcontractor !== !!account.is_subcontractor ||
    form.unitNumber !== (account.unit_number || "") ||
    form.idCode !== (account.id_code || "");

  const save = async () => {
    setSaving(true);
    try { await Db.updateProfileDetails(account.id, form); await onSaved(); }
    catch (e) { onError(e.message || "Couldn't save those details."); }
    setSaving(false);
  };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="First name"><input className="input" value={form.firstName} onChange={e => set("firstName", e.target.value)} /></Field>
        <Field label="Last name"><input className="input" value={form.lastName} onChange={e => set("lastName", e.target.value)} /></Field>
      </div>
      <Field label="Certification"><input className="input" value={form.cert} onChange={e => set("cert", e.target.value)} /></Field>
      {/* Both of these print on the client's field invoice beside this
          person's hours — Level in the LEVEL column, the number in CGSB #.
          Level is a picker rather than a box because the invoice prints the
          legend explaining the codes from the same list. */}
      <Field label="Level">
        <select className="input" value={form.level} onChange={e => set("level", e.target.value)}>
          <option value="">— not set —</option>
          {TECH_LEVELS.map(l => <option key={l.code} value={l.code}>{l.code} — {l.label}</option>)}
        </select>
      </Field>
      <Field label="CGSB# / NRCAN#"><input className="input" value={form.idCode} placeholder="Certification number" onChange={e => set("idCode", e.target.value)} /></Field>

      {/* Unit and dosimetry live on the person because they're assigned, not
          decided per job — the JHA pre-fills from here, so a tech in the field
          confirms rather than types. */}
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", margin: "16px 0 6px" }}>Unit</div>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginBottom: 8 }}>
        Carried onto every JHA this person files. Dosimetry serials now come from what's assigned to them on the Equipment tab.
      </div>
      <Field label="Unit #"><input className="input" value={form.unitNumber} placeholder="e.g. TR-01" onChange={e => set("unitNumber", e.target.value)} /></Field>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0 4px" }}>
        <Switch on={form.isSubcontractor} label="Subcontractor" onClick={() => set("isSubcontractor", !form.isSubcontractor)} />
        <div>
          <div style={{ fontSize: 14 }}>Subcontractor</div>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Their timesheet carries mileage to invoice from</div>
        </div>
      </div>
      {dirty && <Btn variant="primary" onClick={save} disabled={saving} style={{ marginTop: 8 }}>{saving ? "Saving…" : "Save details"}</Btn>}
    </>
  );
}

function NewUserDialog({ onClose, onCreated }) {
  // `invite`: no temporary password to relay by voice — the person gets a
  // set-password link by email and chooses their own.
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", password: "", role: "Technician", cert: "", level: "", isSubcontractor: false, invite: true });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const miss = useMissingFields();
  const set = (k, v) => { miss.fixed(k); setForm(p => ({ ...p, [k]: v })); };

  // What submit() below is about to refuse, counted as it is typed. Every
  // line here is one of its checks — including the password's length, which
  // is why a half-typed one still counts as outstanding.
  const requiredLeft = [
    !form.firstName.trim(),
    !form.lastName.trim(),
    !form.email.trim() || !emailIn(form.email),
    !form.invite && form.password.length < 8
  ].filter(Boolean).length;

  const submit = async () => {
    // Named individually so the highlight lands on the empty one — the old
    // check tested all three together and could only say "all three".
    const gaps = [];
    if (!form.firstName.trim()) gaps.push("firstName");
    if (!form.lastName.trim()) gaps.push("lastName");
    if (!form.email.trim()) gaps.push("email");
    if (gaps.length) { miss.flag(...gaps); setError("First name, last name and email are required."); return; }
    if (!emailIn(form.email)) { miss.flag("email"); setError("That doesn't look like an email address."); return; }
    // The same floor as the reset screen: an account can be created as Admin.
    if (!form.invite && form.password.length < 8) { miss.flag("password"); setError("Password needs to be at least 8 characters."); return; }
    miss.clear();
    setSaving(true);
    setError("");
    try {
      const res = await Db.createUserAccount({
        firstName: form.firstName.trim(), lastName: form.lastName.trim(),
        email: form.email.trim(), password: form.password, role: form.role,
        cert: form.cert.trim() || form.role, level: form.level || null, isSubcontractor: form.isSubcontractor,
        invite: form.invite
      });
      // An account that exists belongs in the list even when something after
      // it went wrong — an invitation that didn't send, the name fields that
      // didn't save. The warning rides up with it, because the way out of
      // both is a button on the account this dialog is about to close over.
      onCreated(res && res.warning);
    } catch (e) {
      setSaving(false);
      setError(e.message || "Couldn't create the account.");
    }
  };

  return (
    <Dialog title="New user" onClose={onClose} actions={<><RequiredLeft count={requiredLeft} style={{ marginRight: "auto", alignSelf: "center" }} /><Btn variant="secondary" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Creating…" : "Create account"}</Btn></>}>
      <ErrorBox>{error}</ErrorBox>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
        {form.invite
          ? "The account is ready the moment it's created. They get an email with a link to choose their password, then sign in with this address."
          : "The account is ready the moment it's created — you made it, so there's no confirmation email; give them the password and they can sign in."}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={form.invite} onChange={e => set("invite", e.target.checked)} />
        Email them a link to set their own password
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="First name" required missing={miss.is("firstName")}>
          <input {...miss.props("firstName")} value={form.firstName} onChange={e => set("firstName", e.target.value)} />
        </Field>
        <Field label="Last name" required missing={miss.is("lastName")}>
          <input {...miss.props("lastName")} value={form.lastName} onChange={e => set("lastName", e.target.value)} />
        </Field>
      </div>
      <Field label="Email" required missing={miss.is("email")}>
        <input {...miss.props("email")} type="email" value={form.email} onChange={e => set("email", e.target.value)} />
      </Field>
      {/* The floor is eight, and has been since the reset screen set it —
          the placeholder said six, so a password the form was about to
          refuse looked like it met the rule. */}
      {!form.invite && (
        <Field label="Temporary password" required missing={miss.is("password")}>
          <input {...miss.props("password")} type="password" value={form.password} onChange={e => set("password", e.target.value)} placeholder="min. 8 characters" />
        </Field>
      )}
      <Field label="Role">
        <select className="input" value={form.role} onChange={e => set("role", e.target.value)}>
          {Object.keys(ROLE_PRESETS).map(r => <option key={r}>{r}</option>)}
        </select>
      </Field>
      <Field label="Certification"><input className="input" value={form.cert} onChange={e => set("cert", e.target.value)} /></Field>
      <Field label="Level">
        <select className="input" value={form.level} onChange={e => set("level", e.target.value)}>
          <option value="">— not set —</option>
          {TECH_LEVELS.map(l => <option key={l.code} value={l.code}>{l.code} — {l.label}</option>)}
        </select>
      </Field>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Switch on={form.isSubcontractor} label="Subcontractor" onClick={() => set("isSubcontractor", !form.isSubcontractor)} />
        <span style={{ fontSize: 14 }}>Subcontractor — mileage appears on their timesheet</span>
      </div>
    </Dialog>
  );
}

