import React, { useState, useEffect, useRef } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, TableScroll, ErrorBox , Loading, openMinted } from "./common.jsx";

// Files — a shared drive for the crew: procedures, certificates, client
// specs, anything that isn't a report or a ticket.
//
// Folders are storage path prefixes rather than database rows (see db.js), so
// what you see here is the bucket itself, not an index of it that could drift
// out of step with what's actually stored.

function fileSize(bytes) {
  if (bytes === 0) return "0 B";
  if (!bytes) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

export function FilesScreen({ currentUser }) {
  // Deleting is an Admin's or a Coordinator's, folder or single file: the
  // drive holds the RT procedure and the report template, one confirm() is
  // the whole guard, and there is no undo. The bucket's delete policy says the
  // same since 20260906181829 — this is the courtesy in front of that gate,
  // not the gate; a refused delete comes back from db.js in words.
  const canDelete = !!currentUser && (currentUser.role === "Admin" || currentUser.role === "Coordinator");
  const [prefix, setPrefix] = useState("");
  const [folders, setFolders] = useState([]);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);

  // A request token: breadcrumbs stay clickable during a load, so navigating
  // folder A → B (or a post-delete reload overlapping a navigation) fires
  // concurrent listFiles calls. Without the guard a slower older one could
  // land last and paint one folder's contents under another folder's
  // breadcrumb — where the row-x delete would then act on a file in a folder
  // the user believes they left.
  const loadSeq = useRef(0);
  const load = async (at = prefix) => {
    const mine = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const { folders, files } = await Db.listFiles(at);
      if (mine !== loadSeq.current) return;
      setFolders(folders);
      setFiles(files);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setError(e.message || "Couldn't load files.");
    }
    if (mine === loadSeq.current) setLoading(false);
  };

  useEffect(() => { load(prefix); }, [prefix]);

  const crumbs = prefix ? prefix.split("/") : [];

  const upload = async list => {
    if (!list || !list.length) return;
    setError("");
    // Collect every failure rather than letting each one overwrite the last —
    // dropping ten files and getting one message about the tenth told you
    // nothing about the other nine.
    const problems = [];
    for (const file of Array.from(list)) {
      setBusy(`Uploading ${file.name}…`);
      try { await Db.uploadSharedFile(prefix, file); }
      catch (e) { problems.push(e.message || `Couldn't upload ${file.name}.`); }
    }
    setBusy("");
    if (problems.length) setError(problems.join(" "));
    // A change to the bucket is what dates the tree the search walks — not
    // a folder click, which used to forget it and cost search a fresh walk
    // of every folder on the next keystroke.
    Db.forgetFileTree();
    await load();
  };

  const addFolder = async () => {
    if (!newFolder.trim()) return;
    setError("");
    try {
      await Db.createFolder(prefix, newFolder);
      setNewFolder("");
      setAdding(false);
      Db.forgetFileTree();
      await load();
    } catch (e) { setError(e.message || "Couldn't create the folder."); }
  };

  // The link is minted inside the tap and pointed at a tab claimed before the
  // await — see openMinted in common.jsx for why the old window.open with
  // `noopener` navigated this tab as well as opening the file.
  const open = async path => {
    setError("");
    try {
      await openMinted(() => Db.sharedFileUrl(path));
    } catch (e) { setError(e.message || "Couldn't open that file."); }
  };

  const removeFile = async f => {
    if (!canDelete) { setError("Deleting a file is an Admin's or Coordinator's — ask one."); return; }
    if (!confirm(`Delete “${f.name}”? This can't be undone.`)) return;
    try { await Db.deleteSharedFile(f.path); Db.forgetFileTree(); await load(); }
    catch (e) { setError(e.message || "Couldn't delete that file."); }
  };

  const removeFolder = async f => {
    if (!canDelete) { setError("Deleting a whole folder is an Admin's or Coordinator's — ask one."); return; }
    if (!confirm(`Delete the folder “${f.name}” and everything inside it? This can't be undone.`)) return;
    setBusy("Deleting…");
    try { await Db.deleteFolder(f.path); Db.forgetFileTree(); await load(); }
    catch (e) { setError(e.message || "Couldn't delete that folder."); }
    setBusy("");
  };

  const q = query.trim().toLowerCase();
  // The empty state quotes the search back so it is clear what was asked, but
  // a pasted paragraph filled the whole table cell with it. Sixty characters
  // is enough to recognise your own search in.
  const shortQuery = query.length > 60 ? query.slice(0, 60) + "…" : query;
  const shownFolders = folders.filter(f => !q || f.name.toLowerCase().includes(q));
  const shownFiles = files.filter(f => !q || f.name.toLowerCase().includes(q));
  const empty = !loading && !shownFolders.length && !shownFiles.length;

  // The same search, everywhere else: files in other folders whose name
  // matches, each with a way to its folder. Finding a procedure used to mean
  // knowing where it lived.
  const [elsewhere, setElsewhere] = useState([]);
  useEffect(() => {
    if (!q) { setElsewhere([]); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      Db.searchFiles(q)
        .then(hits => {
          if (!live) return;
          const here = prefix ? prefix + "/" : "";
          setElsewhere(hits.filter(f => !f.path.startsWith(here) || f.path.slice(here.length).includes("/")));
        })
        .catch(() => { if (live) setElsewhere([]); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, prefix]);
  const folderOf = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 20, gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="kicker">Shared files</div>
          <h2 style={{ fontSize: 34, margin: "2px 0 0" }}>Files</h2>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Btn variant="secondary" style={{ minHeight: 38 }} onClick={() => setAdding(a => !a)}>+ New folder</Btn>
          <Btn variant="primary" style={{ minHeight: 38 }} onClick={() => fileInput.current.click()} disabled={!!busy}>
            {busy || "Upload files"}
          </Btn>
          <input ref={fileInput} type="file" multiple style={{ display: "none" }}
            onChange={e => { upload(e.target.files); e.target.value = ""; }} />
        </div>
      </div>

      {/* Breadcrumb — clicking a crumb walks back up the prefix. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, fontSize: 13, flexWrap: "wrap" }}>
        <a href="#" onClick={e => { e.preventDefault(); setPrefix(""); }}
          style={{ color: prefix ? "var(--color-accent-700)" : "inherit", textDecoration: "none" }}>All files</a>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: "flex", gap: 6 }}>
            <span style={{ color: "color-mix(in srgb, var(--color-text) 40%, transparent)" }}>/</span>
            <a href="#" onClick={e => { e.preventDefault(); setPrefix(crumbs.slice(0, i + 1).join("/")); }}
              style={{ color: i === crumbs.length - 1 ? "inherit" : "var(--color-accent-700)", textDecoration: "none" }}>{c}</a>
          </span>
        ))}
        <input className="input" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Search all folders…" aria-label="Search files"
          style={{ marginLeft: "auto", width: 220, minHeight: 34 }} />
      </div>

      {q && elsewhere.length > 0 && (
        <Blueprint style={{ padding: "8px 18px 10px", marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 6 }}>
            Also found in other folders
          </div>
          {elsewhere.slice(0, 20).map(f => (
            <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", fontSize: 13, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>{f.name}</span>
              <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{folderOf(f.path) || "All files"}</span>
              <Btn variant="ghost" style={{ marginLeft: "auto", minHeight: 30 }} onClick={() => { setPrefix(folderOf(f.path)); setQuery(""); }}>Open folder</Btn>
            </div>
          ))}
          {elsewhere.length > 20 && <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>…and {elsewhere.length - 20} more — narrow the search.</div>}
        </Blueprint>
      )}

      {adding && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input className="input" value={newFolder} autoFocus
            onChange={e => setNewFolder(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addFolder(); if (e.key === "Escape") setAdding(false); }}
            placeholder="Folder name — e.g. Procedures" style={{ width: 280, minHeight: 38 }} />
          <Btn variant="secondary" style={{ minHeight: 38 }} onClick={addFolder}>Create</Btn>
          <Btn variant="secondary" style={{ minHeight: 38 }} onClick={() => { setAdding(false); setNewFolder(""); }}>Cancel</Btn>
        </div>
      )}

      <ErrorBox>{error}</ErrorBox>

      {/* Drop anywhere on the table to upload into the folder you're in. */}
      <Blueprint
        style={{
          padding: "6px 18px 14px",
          // Without feedback there was no way to tell a drop would land here.
          outline: dragging ? "2px dashed var(--color-accent)" : "none",
          outlineOffset: -4
        }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={e => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); }}
      >
        {loading ? (
          <div style={{ padding: "24px 4px" }}><Loading /></div>
        ) : (
          <TableScroll><table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 110 }}>Size</th>
                <th style={{ width: 170 }}>Modified</th>
                <th style={{ width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {empty && (
                <tr><td colSpan={4} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                  {q ? `Nothing here matches “${shortQuery}”.` : "This folder is empty — drop files onto this table, or use Upload files."}
                </td></tr>
              )}

              {shownFolders.map(f => (
                // One handler on the row rather than one per cell, and one
                // stop on the keyboard rather than three — the same shape the
                // ticket rows on Job detail use. Only the row's own key
                // presses open it, so Enter on the delete × can't also walk
                // into the folder it just asked about.
                <tr key={f.path} className="clickable"
                  onClick={() => setPrefix(f.path)}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open folder ${f.name}`}
                  onKeyDown={e => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPrefix(f.path); }
                  }}>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                      <FolderGlyph />
                      <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>{f.name}</span>
                    </span>
                  </td>
                  <td style={{ color: "color-mix(in srgb, var(--color-text) 45%, transparent)" }}>Folder</td>
                  <td></td>
                  <td style={{ textAlign: "right" }}>
                    {/* Stopped here, or the click that deletes a folder also
                        opens it. */}
                    {canDelete && <button onClick={e => { e.stopPropagation(); removeFolder(f); }} aria-label={`Delete folder ${f.name}`} className="row-x">×</button>}
                  </td>
                </tr>
              ))}

              {shownFiles.map(f => (
                <tr key={f.path}>
                  <td>
                    <a href="#" onClick={e => { e.preventDefault(); open(f.path); }}
                      style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                      <FileGlyph name={f.name} />{f.name}
                    </a>
                  </td>
                  <td className="tabular">{fileSize(f.size)}</td>
                  <td style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                    {f.at ? new Date(f.at).toLocaleString("en-CA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : ""}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {canDelete && <button onClick={() => removeFile(f)} aria-label={`Delete ${f.name}`} className="row-x">×</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></TableScroll>
        )}
      </Blueprint>

      <p style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 50%, transparent)", marginTop: 12 }}>
        Files are private to the company — opening one mints a link that expires after ten minutes.
      </p>
    </div>
  );
}

// Drawn, not imaged — same approach as the PDF glyph.
function FolderGlyph() {
  return (
    <span style={{
      width: 18, height: 14, flex: "none", border: "1px solid var(--color-accent)",
      borderTopWidth: 3, display: "inline-block"
    }} />
  );
}

function FileGlyph({ name }) {
  // `"README".split(".").pop()` is "README", not "" — a file with no extension
  // rendered its whole name inside a 16px glyph.
  const parts = String(name || "").split(".");
  const ext = parts.length > 1 ? parts.pop().slice(0, 4).toUpperCase() : "FILE";
  return (
    <span className="pdf-glyph" style={{ width: 16, height: 20, fontSize: 5 }} aria-hidden="true">{ext}</span>
  );
}

