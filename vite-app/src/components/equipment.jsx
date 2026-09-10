import { useState, useEffect, useRef } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, TableScroll, TagX, Field, Dialog, ErrorBox, RowsPerPage, useRowsPerPage } from "./common.jsx";

const EQUIPMENT_TYPES = ["Exposure device", "Survey meter", "Dosimeter", "TLD / OSLD", "Crank", "Guide tube"];
const EQUIPMENT_STATUSES = ["In service", "Out for cal", "Retired"];
const EQUIPMENT_FILTERS = ["All", ...EQUIPMENT_TYPES, "Due soon", "Overdue"];

// Days until due — negative once it's overdue. No date means nothing to flag.
function calDaysLeft(dueStr) {
  if (!dueStr) return null;
  const due = new Date(dueStr + "T12:00:00");
  if (Number.isNaN(+due)) return null;
  return Math.round((due - Date.now()) / 86400000);
}

function CalDueTag({ due }) {
  const days = calDaysLeft(due);
  // No date, or one that doesn't parse — nothing to flag either way. Tested on
  // `days` rather than on `due`, because an unreadable date left `days` null
  // and `null <= 30` is true, which tagged it "due soon".
  if (days == null) return <span style={{ color: "color-mix(in srgb, var(--color-text) 45%, transparent)" }}>{due || "—"}</span>;
  if (days < 0) return <TagX variant="accent">{due} · overdue</TagX>;
  if (days <= 30) return <TagX variant="outline">{due} · due soon</TagX>;
  return <span>{due}</span>;
}

export function EquipmentScreen({ currentUser }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [people, setPeople] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState("All");
  // Serial, type or the person it's assigned to — finding "DRD 4471" used
  // to mean paging through the type filter.
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useRowsPerPage();
  const [editing, setEditing] = useState(null);   // null = closed, {} = new, item = editing
  const canEdit = currentUser.role === "Admin" || currentUser.role === "Coordinator";

  // A request token, so a slow earlier page cannot land after a newer one.
  // Tapping through filters or pages fires overlapping reads, and whichever
  // returns last used to win — repainting stale rows together with a total
  // that belongs to a different query, so the pager and the table disagreed.
  const loadSeq = useRef(0);
  const fetchPage = async (p, f, s = search) => {
    const mine = ++loadSeq.current;
    setLoading(true);
    try {
      const { rows: r, total: t } = await Db.searchEquipment({ page: p, pageSize, filter: f, search: s });
      if (mine !== loadSeq.current) return;
      // The page under us can empty out — retire the last item on the last
      // page and this index has no rows left. The count comes off the first
      // row, so an empty page also reports a total of zero: the screen said
      // "No equipment on file yet." with no pager to get back. Start again
      // at page 1 instead.
      if (p > 0 && !r.length) { setPage(0); fetchPage(0, f, s); return; }
      setRows(r);
      setTotal(t);
      setLoadError("");
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setLoadError(e.message || "Couldn't load equipment.");
    }
    if (mine === loadSeq.current) setLoading(false);
  };
  // Active accounts only: a locked account (delete-user, with work on file)
  // is no longer someone a survey meter can be signed out to.
  const refreshStats = () => { Db.getEquipmentStats().then(setStats).catch(() => {}); };
  // The roster once, for the assign-to dropdown: an equipment write cannot
  // change who is on it, and re-reading it after every save was a paged
  // walk of profiles per edit.
  useEffect(() => { refreshStats(); Db.listActiveProfiles().then(setPeople).catch(() => {}); }, []);
  // Filter and page in one effect: as two, arriving on this screen (and every
  // filter tap that was already on page 1) fetched the same page twice.
  const lastFilter = useRef(null);
  useEffect(() => {
    // A filter or search change lands on page 1; the search waits for a
    // pause in typing so each keystroke isn't a request.
    const key = filter + "\u0000" + search;
    if (lastFilter.current !== null && lastFilter.current !== key && page !== 0) {
      lastFilter.current = key;
      setPage(0);
      return;
    }
    lastFilter.current = key;
    const t = setTimeout(() => fetchPage(page, filter, search), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [filter, search, page, pageSize]);

  const refresh = () => { fetchPage(page, filter, search); refreshStats(); };
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <div className="kicker">Fleet</div>
          <h2 style={{ fontSize: 34, margin: "2px 0 0" }}>Equipment</h2>
        </div>
        {canEdit && (
          <Btn variant="primary" style={{ marginLeft: "auto" }} onClick={() => setEditing({})}>+ Add equipment</Btn>
        )}
      </div>

      {loadError && <ErrorBox>{loadError}</ErrorBox>}

      {stats && (stats.overdue > 0 || stats.dueSoon > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, marginBottom: 20 }} className="grid-2col">
          <Blueprint className="stat-tile">
            <div className="stat-label">Overdue calibration</div>
            <div className="stat-figure" style={{ color: "var(--color-accent-700)" }}>{stats.overdue}</div>
            <div className="stat-note">Pull from service until recalibrated</div>
          </Blueprint>
          <Blueprint className="stat-tile">
            <div className="stat-label">Due within 30 days</div>
            <div className="stat-figure">{stats.dueSoon}</div>
            <div className="stat-note">Schedule calibration now</div>
          </Blueprint>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {EQUIPMENT_FILTERS.map(f => (
          <button key={f} className={`pill${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
        <input className="input" type="search" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search serial, type or person…" aria-label="Search equipment"
          style={{ marginLeft: "auto", maxWidth: 260, minHeight: 36 }} />
        <RowsPerPage value={pageSize} onChange={n => { setPageSize(n); setPage(0); }} />
      </div>

      <Blueprint style={{ padding: "6px 18px 14px" }}>
        {loading && <div style={{ padding: "12px 4px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Loading equipment…</div>}
        <TableScroll><table className="table table-wide">
          <thead>
            <tr><th>Type</th><th>Serial</th><th>Calibration due</th><th>Assigned to</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {!loading && !rows.length && (
              <tr><td colSpan={6} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                {search ? `Nothing matches “${search}”.` : filter === "All" ? "No equipment on file yet." : `Nothing matches “${filter}.”`}
              </td></tr>
            )}
            {!loading && rows.map(i => (
              <tr key={i.id}>
                <td style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}>{i.type}</td>
                <td className="tabular">{i.serial || "—"}</td>
                <td><CalDueTag due={i.calibrationDue} /></td>
                <td>{i.assignedName || "—"}</td>
                <td><TagX variant={i.status === "In service" ? "accent" : i.status === "Retired" ? "neutral" : "outline"}>{i.status}</TagX></td>
                <td>{canEdit && <Btn variant="secondary" onClick={() => setEditing(i)}>Edit</Btn>}</td>
              </tr>
            ))}
          </tbody>
        </table></TableScroll>
        {!loading && pageCount > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 4px 4px" }}>
            <Btn variant="secondary" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>← Previous</Btn>
            <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>Page {page + 1} of {pageCount}</span>
            <Btn variant="secondary" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>Next →</Btn>
          </div>
        )}
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 10 }}>
          {total} item{total === 1 ? "" : "s"}
        </div>
      </Blueprint>

      {editing && (
        <EquipmentDialog item={editing} people={people}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }} />
      )}
    </div>
  );
}

function EquipmentDialog({ item, people, onClose, onSaved }) {
  const isNew = !item.id;
  const [form, setForm] = useState({
    type: item.type || EQUIPMENT_TYPES[0], serial: item.serial || "",
    calibrationDue: item.calibrationDue || "", assignedTo: item.assignedTo || "", status: item.status || "In service"
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      if (isNew) await Db.createEquipment(form);
      else await Db.updateEquipment(item.id, form);
      onSaved();
    } catch (e) {
      setError(e.message || "Couldn't save this item.");
      setSaving(false);
    }
  };

  return (
    <Dialog title={isNew ? "Add equipment" : "Edit equipment"} onClose={onClose}
      actions={<>
        {!isNew && (
          <Btn variant="secondary" onClick={async () => {
            if (!confirm(`Remove this ${item.type} from the equipment list? This can't be undone.`)) return;
            setSaving(true);
            try { await Db.deleteEquipment(item.id); onSaved(); }
            catch (e) { setError(e.message || "Couldn't remove this item."); setSaving(false); }
          }}>Remove</Btn>
        )}
        <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save"}</Btn>
      </>}>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }} className="grid-2col">
          <Field label="Type">
            <select className="input" autoFocus value={form.type} onChange={e => set("type", e.target.value)}>
              {EQUIPMENT_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Serial number"><input className="input" value={form.serial} onChange={e => set("serial", e.target.value)} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }} className="grid-2col">
          <Field label="Calibration due"><input className="input" type="date" value={form.calibrationDue} onChange={e => set("calibrationDue", e.target.value)} /></Field>
          <Field label="Status">
            <select className="input" value={form.status} onChange={e => set("status", e.target.value)}>
              {EQUIPMENT_STATUSES.map(s => <option key={s}>{s}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Assigned to">
          <select className="input" value={form.assignedTo} onChange={e => set("assignedTo", e.target.value)}>
            <option value="">Unassigned</option>
            {/* Helpers included: the JHA fills worker (2)'s TLD, DRD and
                alarming dosimeter from what is assigned to them here, which
                nothing could do while they weren't assignable. */}
            {people.filter(p => ["Technician", "Admin", "Coordinator", "Helper"].includes(p.role)).map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        </Field>
      </div>
    </Dialog>
  );
}
