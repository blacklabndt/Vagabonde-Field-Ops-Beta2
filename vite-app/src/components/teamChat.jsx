import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Db } from "../db.js";
import { heldDraftFor, holdDraft, heldComposerFor, holdComposer } from "../chatDrafts.js";
import { initialsOf } from "../data.js";
// The merge every message path funnels through — see chatMerge.js,
// where the regression tests hold the door on the "Someone" bug.
import { mergeIn, reconcileWindow, quotedKey } from "../chatMerge.js";
import { Blueprint, Btn, Dialog, ErrorBox, Loading, Switch, openMinted } from "./common.jsx";

// Team chat — one room for the whole crew.
//
// Three feeds keep the room current, cheapest first: the realtime
// subscription carries messages (and pin and reaction changes) as they
// land; a polling sweep catches anything a silently dropped websocket
// missed — every 30 seconds while the feed is down, every two minutes
// as a safety net while it is delivering; and regaining focus refreshes
// immediately, because that is the moment somebody is looking.
// Everything funnels through one id-keyed merge, so no path can double
// a message another path already delivered.
//
// Admins can pin a message to a strip at the top of the room. A message
// can also carry a picture — photos and GIFs — which big phone cameras
// make worth shrinking before they cross a field connection.
//
// Deliberately online-only (see Db.listChatMessages): a message that
// cannot send right now fails softly and stays in the composer, rather
// than joining the offline queue to be said hours out of turn.

const REFRESH_MS = 30000;

// What the storage bucket accepts. Anything else the browser can still
// decode (a HEIC off an iPhone, a BMP) is transcoded to JPEG on the way.
const CHAT_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_EDGE_PX = 1600;
const KEEP_AS_IS_BYTES = 1.5 * 1024 * 1024;

// A phone photo is 10MB+ of pixels nobody needs at chat size. Shrink to
// 1600px JPEG before upload — except GIFs, whose animation a canvas
// would freeze, so they go up as they are (the bucket caps them at 8MB).
async function shrinkForChat(file) {
  if (file.type === "image/gif") return file;
  try {
    const bmp = await createImageBitmap(file);
    const oversized = bmp.width > MAX_EDGE_PX || bmp.height > MAX_EDGE_PX;
    if (!oversized && file.size <= KEEP_AS_IS_BYTES && CHAT_IMAGE_TYPES.has(file.type)) {
      bmp.close();
      return file;
    }
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!blob) return file;
    const stem = (file.name || "photo").replace(/\.[^.]*$/, "");
    return new File([blob], stem + ".jpg", { type: "image/jpeg" });
  } catch (_) {
    // A format this browser can't decode — send as-is and let the bucket
    // rules give the real answer.
    return file;
  }
}


// Whether the app's own Animations switch (drawer footer) is off —
// read at call time so flipping it applies without a reload. The smooth
// scrolls fall back to instant jumps when it is.
const motionOff = () => document.documentElement.getAttribute("data-motion") === "off";

// The curated reaction set — must match the chat_reactions check.
const REACTION_SET = ["👍", "❤️", "😂", "😮", "🔥", "👌"];

// The composer's icons — inline strokes that inherit the button's colour.
// GIF stays a word on purpose: no pictogram says "GIF" better than it
// says itself.
const iconProps = {
  width: 20, height: 20, viewBox: "0 0 24 24", "aria-hidden": true,
  fill: "none", stroke: "currentColor", strokeWidth: 1.8,
  strokeLinecap: "round", strokeLinejoin: "round"
};
// One box for all four composer buttons. Three hold a 20px icon and the
// fourth holds the word "GIF" — left to size themselves, a letter button and
// an icon button come out different widths (and, because a text line-box is
// not 20px tall, different heights), which read as a misfit on the wider
// desktop row. A fixed square that centres either keeps them a matched set.
const composerBtnStyle = {
  width: 48, height: 42, padding: 0, flex: "none",
  display: "inline-flex", alignItems: "center", justifyContent: "center"
};
const IconPhoto = () => (
  <svg {...iconProps}>
    <rect x="3" y="5" width="18" height="14" />
    <circle cx="9" cy="10" r="1.7" />
    <path d="m5 17 4.5-4.5 3.5 3.5 3-3L21 17" />
  </svg>
);
const IconClip = () => (
  <svg {...iconProps}>
    <path d="M21.4 11.1 12.2 20.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  </svg>
);
const IconMic = () => (
  <svg {...iconProps}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
    <path d="M12 18v4" />
  </svg>
);
const IconSend = () => (
  <svg {...iconProps}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </svg>
);

// One tint per person, picked by hashing their id — stable across
// devices with no table behind it. Muted hues that sit on both themes.
const CHIP_HUES = ["#5980a6", "#6a8f5f", "#a67a59", "#8a6a9e", "#a05f6d", "#5f9a94"];
function chipHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CHIP_HUES[h % CHIP_HUES.length];
}

// A voice note in a bubble. Same signed-URL life as the pictures; a link
// that expires before the first play gets minted once more, then gives up
// honestly.
function ChatAudio({ audioKey }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  useEffect(() => {
    let live = true;
    retried.current = false;
    setUrl("");
    setFailed(false);
    Db.signedUrl("chat-media", audioKey)
      .then(u => { if (live) setUrl(u); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [audioKey]);
  const onError = () => {
    if (retried.current) { setFailed(true); return; }
    retried.current = true;
    Db.signedUrl("chat-media", audioKey, { fresh: true }).then(setUrl).catch(() => setFailed(true));
  };
  if (failed) {
    return <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", padding: "6px 0" }}>Couldn't load the voice note.</div>;
  }
  if (!url) {
    return <div style={{ width: 230, height: 40, background: "color-mix(in srgb, var(--color-text) 6%, transparent)" }} />;
  }
  return <audio controls preload="metadata" src={url} onError={onError} style={{ display: "block", width: 230, maxWidth: "100%" }} />;
}

// The GIF search. Opens on what's trending, then searches as you type —
// straight against KLIPY from this browser, as their terms require; the
// Edge Function only hands over the app key (see Db.searchGifs). Tapping a
// GIF chooses it and shows it whole; a second tap sends it. Every tile used
// to be a send, on a grid of thumbnails a thumb scrolls past, with no undo
// once it was in the room. Whatever is typed in the composer stays there.
function GifPicker({ onPick, onClose, busy }) {
  const [chosen, setChosen] = useState(null);
  const [term, setTerm] = useState("");
  const [gifs, setGifs] = useState([]);
  const [searching, setSearching] = useState(true);
  const [error, setError] = useState("");
  // A request token, so a slow earlier search cannot land after a newer one.
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      Db.searchGifs(term)
        .then(list => { if (mine === seq.current) { setGifs(list); setError(""); } })
        .catch(e => { if (mine === seq.current) { setGifs([]); setError(e.message || "Couldn't search for GIFs."); } })
        .finally(() => { if (mine === seq.current) setSearching(false); });
    }, term ? 350 : 0);
    return () => clearTimeout(timer);
  }, [term]);

  if (chosen) {
    return (
      <Dialog title="Send this GIF?" maxWidth={440} onClose={onClose} actions={<>
        <Btn variant="secondary" onClick={() => setChosen(null)} disabled={busy}>Pick another</Btn>
        <Btn variant="primary" onClick={() => onPick(chosen)} disabled={busy}>{busy ? "Sending…" : "Send GIF"}</Btn>
      </>}>
        <img src={chosen} alt="The GIF about to be sent"
          style={{ display: "block", margin: "0 auto", maxWidth: "100%", maxHeight: "46vh", objectFit: "contain" }} />
      </Dialog>
    );
  }

  return (
    <Dialog title="Send a GIF" maxWidth={560} onClose={onClose}>
      <input
        className="input"
        value={term}
        onChange={e => setTerm(e.target.value)}
        placeholder="Search GIFs…"
        autoFocus
        style={{ marginBottom: 10 }}
      />
      {error ? (
        <ErrorBox>{error}</ErrorBox>
      ) : searching && gifs.length === 0 ? (
        <Loading label="Finding GIFs…" />
      ) : gifs.length === 0 ? (
        <div style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)", padding: "16px 0" }}>
          Nothing for that — try another word.
        </div>
      ) : (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
          gap: 8, maxHeight: "50vh", overflowY: "auto", opacity: searching ? 0.6 : 1
        }}>
          {gifs.map(g => (
            <button
              key={g.id}
              onClick={() => setChosen(g.full)}
              disabled={busy}
              aria-label="Choose this GIF"
              style={{ padding: 0, border: "1px solid var(--color-divider)", background: "transparent", cursor: "pointer" }}
            >
              {/* KLIPY's blurred stand-in paints the cell instantly; the
                  real frames fade in over it as they arrive. */}
              <div style={{
                position: "relative", width: "100%", height: 110,
                backgroundImage: g.blur ? `url(${g.blur})` : undefined,
                backgroundSize: "cover", backgroundPosition: "center"
              }}>
                <img src={g.preview} alt="" loading="lazy"
                  onLoad={e => { e.currentTarget.style.opacity = "1"; }}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0, transition: "opacity .3s ease-out" }} />
              </div>
            </button>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 45%, transparent)", marginTop: 8 }}>
        Powered by KLIPY
      </div>
    </Dialog>
  );
}

// Browse the Files page's shared bucket and pick one file to link into
// the room. The chat only ever references these files — the Files page
// keeps custody, so nothing here uploads, moves or deletes anything.
// Picking names the file and waits: tapping a row used to post it, and the
// rows are a list of filenames a thumb scrolls through.
function FilePickerDialog({ onPick, onClose, busy }) {
  const [chosen, setChosen] = useState(null);
  const [prefix, setPrefix] = useState("");
  const [listing, setListing] = useState({ folders: [], files: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    Db.listFiles(prefix)
      .then(l => { if (live) { setListing(l); setError(""); } })
      .catch(e => { if (live) setError(e.message || "Couldn't list the files."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [prefix]);

  const rowStyle = {
    display: "flex", alignItems: "center", gap: 8, width: "100%",
    padding: "9px 10px", background: "transparent", border: "none",
    borderBottom: "1px solid var(--color-divider)", cursor: "pointer",
    font: "inherit", color: "inherit", textAlign: "left"
  };

  if (chosen) {
    return (
      <Dialog title="Share this file?" maxWidth={440} onClose={onClose} actions={<>
        <Btn variant="secondary" onClick={() => setChosen(null)} disabled={busy}>Cancel</Btn>
        <Btn variant="primary" onClick={() => onPick(chosen)} disabled={busy}>{busy ? "Sending…" : "Send"}</Btn>
      </>}>
        <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{chosen.name}</div>
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
          The message carries a link to it in Files, not a copy.
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Share a file" maxWidth={520} onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
        {prefix ? (
          <>
            <Btn variant="secondary" onClick={() => setPrefix(prefix.split("/").slice(0, -1).join("/"))}>Back</Btn>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prefix}</span>
          </>
        ) : (
          "Everything from the Files page. Tap a file to choose it."
        )}
      </div>
      {error ? (
        <ErrorBox>{error}</ErrorBox>
      ) : loading ? (
        <Loading label="Listing files…" />
      ) : listing.folders.length === 0 && listing.files.length === 0 ? (
        <div style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)", padding: "14px 0" }}>
          Nothing in this folder.
        </div>
      ) : (
        <div style={{ maxHeight: "50vh", overflowY: "auto", borderTop: "1px solid var(--color-divider)" }}>
          {listing.folders.map(f => (
            <button key={f.path} onClick={() => setPrefix(f.path)} style={rowStyle}>
              <span style={{ flex: "none", fontSize: 9, fontWeight: 700, letterSpacing: ".06em", padding: "3px 5px", border: "1px solid var(--color-divider)", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>DIR</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
            </button>
          ))}
          {listing.files.map(f => (
            <button key={f.path} onClick={() => setChosen({ path: f.path, name: f.name })} disabled={busy} style={rowStyle}>
              <span style={{ flex: "none", fontSize: 9, fontWeight: 700, letterSpacing: ".06em", padding: "3px 5px", border: "1px solid color-mix(in srgb, var(--color-accent) 55%, transparent)", color: "var(--color-accent)" }}>
                {(f.name.split(".").pop() || "file").toUpperCase().slice(0, 4)}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// A picture in a bubble. The bucket is private, so viewing means a signed
// URL — minted on mount for the inline copy; opening it big goes through
// onOpen, which mints its own fresh link (see openImage below).
function ChatImage({ imageKey, onSized, onOpen }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  useEffect(() => {
    let live = true;
    retried.current = false;
    setUrl("");
    setFailed(false);
    Db.signedUrl("chat-media", imageKey)
      .then(u => { if (live) setUrl(u); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [imageKey]);
  // The <img> is loading="lazy", so an off-screen picture isn't fetched until
  // it nears the viewport — which can be well past the signed URL's 10-minute
  // life on a phone left with chat open. Re-mint once on the load error before
  // giving up, the same recovery ChatAudio has.
  const onError = () => {
    if (retried.current) { setFailed(true); return; }
    retried.current = true;
    Db.signedUrl("chat-media", imageKey, { fresh: true }).then(setUrl).catch(() => setFailed(true));
  };

  if (failed) {
    return <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", padding: "6px 0" }}>Couldn't load the picture.</div>;
  }
  if (!url) {
    return <div style={{ width: 200, height: 130, background: "color-mix(in srgb, var(--color-text) 6%, transparent)" }} />;
  }
  return (
    <img
      src={url} alt="Shared picture" loading="lazy"
      onLoad={onSized}
      onError={onError}
      onClick={onOpen}
      style={{ display: "block", maxWidth: "100%", maxHeight: 320, cursor: "zoom-in" }}
    />
  );
}

// The pinned strip's thumbnail. While the signed URL is on its way — or
// if it never arrives — the old "(picture)" label stands in, so the row
// always says what it holds.
function PinThumb({ pin, onOpen }) {
  const [url, setUrl] = useState(pin.gifUrl || "");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (pin.gifUrl) { setUrl(pin.gifUrl); return; }
    let live = true;
    Db.signedUrl("chat-media", pin.imageKey)
      .then(u => { if (live) setUrl(u); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [pin.imageKey, pin.gifUrl]);

  if (failed || !url) {
    return <span style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)", flex: "none" }}>{pin.gifUrl ? "(GIF)" : "(picture)"}</span>;
  }
  return (
    <img
      src={url} alt={pin.gifUrl ? "Pinned GIF" : "Pinned picture"} loading="lazy"
      onClick={onOpen}
      style={{ height: 34, width: 48, objectFit: "cover", border: "1px solid var(--color-divider)", cursor: "zoom-in", flex: "none" }}
    />
  );
}

// Any picture or GIF, the full screen. Tapping anywhere — or Escape —
// puts the room back.
function Lightbox({ src, onClose }) {
  useEffect(() => {
    // Capture phase, and the Escape stops there. A picture opened from the
    // pinned-message dialog put two listeners on window, and Dialog's — a
    // bubble-phase one, see common.jsx — ran on the same key press, so one
    // Escape closed the picture AND the dialog underneath it. Capture runs
    // first, so stopping propagation here means the layer below never hears
    // the key that was meant for this one. stopImmediatePropagation covers
    // a second capture-phase listener on window as well.
    const onKey = e => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      className="lightbox-in"
      role="dialog" aria-label="Picture, full screen"
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(10, 11, 12, .9)", display: "grid", placeItems: "center", cursor: "zoom-out", padding: 14 }}
    >
      <img src={src} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
      <button
        onClick={onClose}
        aria-label="Close the picture"
        style={{ position: "absolute", top: 10, right: 14, background: "transparent", border: "none", color: "#f2f2f3", fontSize: 30, lineHeight: 1, cursor: "pointer", padding: 6 }}
      >
        ×
      </button>
    </div>
  );
}


// Past this many characters the composer starts counting down to the 4,000
// the column accepts, so the limit is not something you meet by surprise.
const DRAFT_MAX = 4000;
const DRAFT_WARN_FROM = 3500;

// Body text with web addresses made tappable and any real job number
// turned into a tap-through to the job. URLs first; the job pass runs
// on what's left, split on word-shaped tokens (odd indexes are the
// candidates in both passes). Membership in jobNums, never a pattern —
// job numbers are freeform. Module-level so a memoized row can call it.
function renderBody(text, jobNums, openJobNumber) {
  const out = [];
  const urlParts = String(text).split(/(https?:\/\/[^\s<>"']+)/g);
  urlParts.forEach((seg, i) => {
    if (i % 2 === 1) {
      out.push(
        <a key={"u" + i} href={seg} target="_blank" rel="noopener noreferrer"
          style={{ color: "var(--color-accent)", overflowWrap: "anywhere" }}>
          {seg}
        </a>
      );
      return;
    }
    if (!seg) return;
    if (!jobNums || !jobNums.size) { out.push(seg); return; }
    const parts = seg.split(/([A-Za-z0-9][A-Za-z0-9-]{2,19})/g);
    parts.forEach((part, j) => {
      if (j % 2 === 1 && /\d/.test(part) && jobNums.has(part.toUpperCase())) {
        out.push(
          <button key={`j${i}-${j}`} onClick={() => openJobNumber(part)}
            style={{ background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "var(--color-accent)", textDecoration: "underline" }}>
            {part}
          </button>
        );
      } else if (part) out.push(part);
    });
  });
  return out;
}

// What the pinned strip renders, joined, so an unchanged strip keeps its
// array (name arrives late from the directory, so it is part of the key).
// quoted is the one field that moves for a given message (the quote goes
// null when the quoted message dies), and the pin dialog shows it.
const pinKey = pins => (pins || []).map(p => [p.id, p.pinnedAt, p.name, p.body, p.imageKey, p.gifUrl, p.audioKey, p.fileName, quotedKey(p.quoted)].join("\u0001")).join("\u0002");

const MUTED = "color-mix(in srgb, var(--color-text) 55%, transparent)";
const TINY_BTN = { background: "transparent", border: "none", cursor: "pointer", color: MUTED, padding: 2, lineHeight: 1 };

// One message. Memoized on its own props, so a reaction landing on this
// morning's message, a ⋯ tap, or a new arrival re-renders the row it
// touches and not the hundred above it — the room's useMemo used to
// rebuild every bubble, and re-split every body, on each of those.
// `h` is a ref holding the current handlers: they close over refs,
// functional setState and Db, and reading them through the ref keeps
// this memo from ever seeing a new function identity. `quiet` is decided
// by the parent — the entrance animation must not read a ref in here.
const ChatRow = React.memo(function ChatRow({ m, mine, newRun, quiet, menuOpen, isAdmin, uid, jobNums, h }) {
  const hue = chipHue(m.profileId);
  const hasMedia = !!(m.imageKey || m.gifUrl);
  // Reactions grouped for the chips: one per emoji, count and
  // whether one of them is yours.
  const reactionGroups = [];
  if (m.reactions && m.reactions.length) {
    const byEmoji = new Map();
    for (const r of m.reactions) {
      const g = byEmoji.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
      g.count++;
      if (r.profileId === uid) g.mine = true;
      byEmoji.set(r.emoji, g);
    }
    reactionGroups.push(...byEmoji.values());
  }
  return (
<div
      className={quiet ? undefined : "chat-msg-in"}
      style={{ display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start", marginTop: newRun ? 12 : 3 }}>
      {newRun && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexDirection: mine ? "row-reverse" : "row", marginBottom: 3 }}>
          <span aria-hidden="true" style={{
            width: 22, height: 22, display: "grid", placeItems: "center", flex: "none",
            fontSize: 10, fontWeight: 700, letterSpacing: ".03em",
            color: hue,
            background: `color-mix(in srgb, ${hue} 20%, transparent)`,
            border: `1px solid color-mix(in srgb, ${hue} 45%, transparent)`
          }}>
            {initialsOf(m.name || "").slice(0, 2) || "•"}
          </span>
          <span style={{ fontSize: 11, color: MUTED }}>
            {mine ? "You" : (m.name || "Someone")} · {new Date(m.createdAt).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })}
          </span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexDirection: mine ? "row-reverse" : "row", maxWidth: "86%" }}>
        <div style={{
          padding: 0, overflow: "hidden", fontSize: 14, lineHeight: 1.45,
          background: mine
            ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
            : "color-mix(in srgb, var(--color-text) 7%, transparent)",
          border: "1px solid " + (mine
            ? "color-mix(in srgb, var(--color-accent) 35%, transparent)"
            : "var(--color-divider)")
        }}>
          {m.quoted && (
            <div style={{
              margin: "8px 12px 0", padding: "4px 8px", fontSize: 12,
              borderLeft: "2px solid color-mix(in srgb, var(--color-accent) 55%, transparent)",
              background: "color-mix(in srgb, var(--color-text) 5%, transparent)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320
            }}>
              <span style={{ color: "var(--color-accent)", fontWeight: 600 }}>{m.quoted.name || "Someone"}</span>
              <span style={{ color: MUTED }}> — {m.quoted.body || m.quoted.label}</span>
            </div>
          )}
          {m.gifUrl && (
            // Straight off KLIPY's CDN — the constraint on the column
            // is what keeps this an image host, not a tracking pixel.
            // Media runs to the bubble's edges; only words get padding.
            <img src={m.gifUrl} alt="GIF" loading="lazy" onLoad={() => h.current.restick()}
              onClick={() => h.current.openImage(m)}
              style={{ display: "block", maxWidth: "100%", maxHeight: 320, cursor: "zoom-in", marginTop: m.quoted ? 8 : 0 }} />
          )}
          {m.imageKey && (
            <div style={{ marginTop: m.quoted ? 8 : 0 }}>
              <ChatImage imageKey={m.imageKey} onSized={() => h.current.restick()} onOpen={() => h.current.openImage(m)} />
            </div>
          )}
          {m.audioKey && (
            <div style={{ padding: "8px 10px" }}>
              <ChatAudio audioKey={m.audioKey} />
            </div>
          )}
          {m.fileKey && (
            <button onClick={() => h.current.openSharedFile(m)}
              title="Open this file from the Files page"
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "transparent", border: "none", cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left", maxWidth: "100%" }}>
              <span style={{ flex: "none", fontSize: 9, fontWeight: 700, letterSpacing: ".06em", padding: "3px 5px", border: "1px solid color-mix(in srgb, var(--color-accent) 55%, transparent)", color: "var(--color-accent)" }}>
                {(m.fileName.split(".").pop() || "file").toUpperCase().slice(0, 4)}
              </span>
              <span style={{ textDecoration: "underline", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.fileName}
              </span>
            </button>
          )}
          {m.body && (
            <div style={{ padding: hasMedia ? "6px 12px 8px" : "8px 12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {renderBody(m.body, jobNums, h.current.openJobNumber)}
            </div>
          )}
        </div>
        {/* One quiet ⋯ instead of a row of controls. Reply and the
            reactions are for everyone; moderation — pin and delete —
            is an Admin's job. A tech's own messages stand as sent
            until the 30-day sweep takes them. */}
        {/* The glyph stays quiet; the target does not. This is the only
            way to reach Reply, and it was 16 × 18 px — six of them down a
            390 px screen, none of them hittable with gloves on. The
            padding is the hit area, not the mark. */}
        <button onClick={() => h.current.setMenuFor(menuOpen ? null : m.id)}
          aria-label="Message actions" title="Message actions"
          aria-expanded={menuOpen}
          style={{
            ...TINY_BTN, fontSize: 14, fontWeight: 700, flex: "none",
            width: 44, height: 44, padding: 0,
            display: "inline-flex", alignItems: "center", justifyContent: "center"
          }}>
          ⋯
        </button>
      </div>
      {menuOpen && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4, justifyContent: mine ? "flex-end" : "flex-start" }}>
          {REACTION_SET.map(e => (
            <button key={e} onClick={() => { h.current.setMenuFor(null); h.current.react(m, e); }}
              aria-label={"React with " + e}
              style={{ ...TINY_BTN, fontSize: 15, padding: "2px 4px" }}>
              {e}
            </button>
          ))}
          <button onClick={() => { h.current.setMenuFor(null); h.current.setReplyTarget(m); }}
            style={{ ...TINY_BTN, fontSize: 11, fontWeight: 600 }}>
            Reply
          </button>
          {isAdmin && (
            <button onClick={() => { h.current.setMenuFor(null); h.current.togglePin(m); }}
              style={{ ...TINY_BTN, fontSize: 11, fontWeight: 600 }}>
              {m.pinnedAt ? "Unpin" : "Pin"}
            </button>
          )}
          {isAdmin && (
            <button onClick={() => { h.current.setMenuFor(null); h.current.remove(m.id); }}
              aria-label="Remove this message" title="Remove this message"
              style={{ ...TINY_BTN, fontSize: 15 }}>
              ×
            </button>
          )}
        </div>
      )}
      {reactionGroups.length > 0 && (
        <div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap", justifyContent: mine ? "flex-end" : "flex-start" }}>
          {reactionGroups.map(g => (
            <button key={g.emoji} onClick={() => h.current.react(m, g.emoji)}
              aria-label={g.emoji + " — " + g.count + (g.mine ? ", including you" : "")}
              title={g.mine ? "Tap to take yours back" : "Tap to react too"}
              style={{
                fontSize: 12, padding: "1px 7px", cursor: "pointer",
                background: g.mine
                  ? "color-mix(in srgb, var(--color-accent) 14%, transparent)"
                  : "color-mix(in srgb, var(--color-text) 5%, transparent)",
                border: "1px solid " + (g.mine
                  ? "color-mix(in srgb, var(--color-accent) 55%, transparent)"
                  : "var(--color-divider)"),
                color: "var(--color-text)"
              }}>
              {g.emoji} {g.count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export function TeamChatScreen({ currentUser, onOpenJob, onRead }) {
  const [messages, setMessages] = useState([]);
  const [pins, setPins] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState(() => heldDraftFor(currentUser.id));
  // { file, url } awaiting send. A picture chosen before a screen change is
  // offered back with a fresh URL — the File is what is held, see chatDrafts.
  const [attach, setAttach] = useState(() => {
    const f = heldComposerFor(currentUser.id).attachFile;
    return f ? { file: f, url: URL.createObjectURL(f) } : null;
  });
  const [gifOpen, setGifOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  // Whether the realtime feed is actually delivering. False is not an
  // error state — the poll still carries the room — but it is said out
  // loud below the composer instead of being invisible. The ref mirrors
  // it for the interval, whose closure only ever saw the first render.
  const [feedLive, setFeedLive] = useState(false);
  const feedLiveRef = useRef(false);
  // The full-screen viewer: the URL it shows, or null when closed.
  const [lightbox, setLightbox] = useState(null);
  // "unsupported" hides the switch; "blocked"/"off"/"on" render it.
  const [pushState, setPushState] = useState("unsupported");
  const [pushBusy, setPushBusy] = useState(false);
  // The message being answered — its quote rides the next send.
  // Held across a screen change like the words; the room's first load
  // drops it again if the message has gone (reconcileWindow, below).
  const [replyTarget, setReplyTarget] = useState(() => heldComposerFor(currentUser.id).reply);
  // Which message's ⋯ menu is open, if any.
  const [menuFor, setMenuFor] = useState(null);
  // Where this person had read up to when they walked in — the "new
  // messages" line sits there and stays put while they catch up.
  const [entryMark, setEntryMark] = useState(null);
  // The current local day, so the "Today" divider stays correct on a phone
  // left open across midnight. The message list can sit idle for hours (an
  // unchanged poll returns the same array, so the row memo never recomputes
  // on its own), and without this the last band kept reading "Today" into
  // the next day. Checked each minute; only a real day change re-renders.
  const [dayStamp, setDayStamp] = useState(() => new Date().toDateString());
  useEffect(() => {
    const t = setInterval(() => {
      const now = new Date().toDateString();
      setDayStamp(prev => (prev === now ? prev : now));
    }, 60000);
    return () => clearInterval(t);
  }, []);
  // Every job number, uppercased, so a word in a message can be looked up.
  const [jobNums, setJobNums] = useState(null);
  // A voice note in progress: { startedAt } while the mic is hot.
  const [recording, setRecording] = useState(null);
  const [recElapsed, setRecElapsed] = useState(0);
  // A finished recording waiting to be listened to and sent: { file, url }.
  // Nothing reaches the room from the microphone without passing through here.
  const [voiceNote, setVoiceNote] = useState(() => {
    const f = heldComposerFor(currentUser.id).voiceFile;
    return f ? { file: f, url: URL.createObjectURL(f) } : null;
  });
  // "↓ new messages" — shown when something lands while scrolled up.
  const [jumpChip, setJumpChip] = useState(false);
  // Crewmates with the room open right now (never includes yourself).
  const [others, setOthers] = useState([]);
  // The Files-page picker, and its browse position.
  const [fileOpen, setFileOpen] = useState(false);
  // A pinned message opened whole — the strip shows headlines, this
  // shows the story.
  const [pinView, setPinView] = useState(null);

  const listRef = useRef(null);
  const fileRef = useRef(null);
  // Follow the conversation while the reader is at (or near) the bottom;
  // stop the moment they scroll up to read back, so an arriving message
  // cannot yank the history out from under them.
  const stickToBottom = useRef(true);
  // Set to the list's previous scrollHeight just before older messages are
  // prepended — the layout effect uses it to hold the reader's place.
  const restoreHeight = useRef(null);
  // Sender names for realtime arrivals, whose rows come without the join.
  const nameOf = useRef(new Map());
  // Every id that has been on screen. The read bookmark moves only for
  // messages new to the room — not for a reaction landing on an old one,
  // which also changes the merged array — and only while the reader is at
  // the bottom to see them arrive; a poll landing while someone reads back
  // through the morning used to zero the badges over messages they had
  // never scrolled to.
  const seenIds = useRef(new Set());
  useEffect(() => { messages.forEach(m => { seenIds.current.add(m.id); }); }, [messages]);
  // Rows that must mount without the entrance animation: everything the
  // initial load and the "Show earlier" pages bring in. A message not in
  // this set is one that arrived while you were watching — those rise in.
  const quietIds = useRef(new Set());
  // The recorder, its stream and its chunks while the mic is hot.
  const recRef = useRef(null);
  // The last message's id as of the previous render — how an arrival
  // while scrolled up is told apart from a prepend or a pin change.
  const prevTail = useRef(null);
  // onRead is an inline prop from App; the ref keeps the mount-time
  // closures below pointing at the current one.
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  // Reading the room settles the drawer badge: note where the person had
  // read up to (the divider's anchor), then move their bookmark to now.
  useEffect(() => {
    let live = true;
    Db.getChatLastRead(currentUser.id)
      .then(t => { if (live) setEntryMark(t); })
      .catch(() => {})
      .finally(() => {
        Db.markChatRead(currentUser.id)
          .then(() => { if (onReadRef.current) onReadRef.current(); })
          .catch(() => {});
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The linkifier's dictionary. Nothing to do until it arrives — messages
  // render as plain text and upgrade when the list lands.
  useEffect(() => {
    let live = true;
    Db.listJobNumbers()
      .then(nums => { if (live) setJobNums(new Set(nums.map(n => String(n).toUpperCase()))); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const named = m => m.name ? m : { ...m, name: nameOf.current.get(m.profileId) || "" };

  // Pin state changes arrive as updates; the strip mirrors them. The list
  // is rebuilt rather than patched — it is at most twenty rows.
  const applyPinChange = m => {
    setPins(prev => {
      const rest = prev.filter(p => p.id !== m.id);
      if (!m.pinnedAt) return rest.length === prev.length ? prev : rest;
      const was = prev.find(p => p.id === m.id);
      const withName = m.name || !was ? named(m) : { ...m, name: was.name };
      return [...rest, withName].sort((a, b) => (a.pinnedAt < b.pinnedAt ? 1 : -1));
    });
  };

  useEffect(() => {
    let live = true;

    Db.listProfiles()
      .then(people => {
        if (!live) return;
        nameOf.current = new Map(people.map(p => [p.id, p.displayName]));
        // Anyone who arrived over realtime before the directory did.
        setMessages(prev => {
          const filled = prev.map(m => m.name ? m : { ...m, name: nameOf.current.get(m.profileId) || "" });
          return filled.some((m, i) => m !== prev[i]) ? filled : prev;
        });
      })
      .catch(() => {}); // names degrade to "Someone", the room still works

    const loadLatest = initial => {
      // The instant this refresh was asked for, kept for reconcileWindow:
      // anything sent after it cannot be in the page that comes back, and
      // must not be read as a message the server no longer has.
      const readAt = Date.now();
      return Promise.all([Db.listChatMessages(), Db.listPinnedChatMessages()])
        .then(([{ messages: page, hasMore: more }, pinned]) => {
          if (!live) return;
          // The room you walk into holds still; only what arrives after
          // you is animated.
          if (initial) page.forEach(m => { quietIds.current.add(m.id); });
          // Messages that arrive by poll — the room's only pulse while the
          // realtime channel is down — are read on screen like any other,
          // so the bookmark moves for them too; it used to move only for
          // the realtime path, and the drawer badge grew over messages the
          // reader was looking at. Decided out here, before the merge, from
          // the ids: an updater has to stay pure (React may run it twice),
          // and "the array changed" also fires for a reaction on an old row.
          const fresh = page.some(m => !seenIds.current.has(m.id));
          // Merge what the page brought, then let it take away what it says
          // is gone — a message deleted while realtime was down otherwise
          // sat here for the life of the open room, and replying to it is
          // refused by the reply_to foreign key.
          setMessages(prev => reconcileWindow(mergeIn(prev, page), page, readAt));
          // Including the one being replied to: the composer must not hold
          // a parent the room has just dropped. Asked of reconcileWindow
          // itself so the answer cannot drift from the room's.
          setReplyTarget(rt => (rt && !reconcileWindow([rt], page, readAt).length ? null : rt));
          if (!initial && fresh && stickToBottom.current && document.visibilityState === "visible") noteRead();
          // Identity matters here as it does for the rows: an equal-but-new
          // array re-renders the whole screen on every poll and every
          // return to the tab, for a strip that has not changed.
          setPins(prev => (pinKey(prev) === pinKey(pinned) ? prev : pinned));
          if (initial) setHasMore(more);
          setLoadError("");
        })
        .catch(e => {
          if (!live) return;
          if (initial) setLoadError(e.message || "Couldn't load the chat.");
        })
        .finally(() => { if (live && initial) setLoading(false); });
    };

    loadLatest(true);

    // The bookmark move for arriving messages, debounced: a burst is one
    // upsert. Cleared with everything else on unmount.
    let readTimer = null;
    const noteRead = () => {
      if (readTimer) return;
      readTimer = setTimeout(() => {
        readTimer = null;
        if (!live) return;
        Db.markChatRead(currentUser.id)
          .then(() => { if (onReadRef.current) onReadRef.current(); })
          .catch(() => {});
      }, 1500);
    };

    // The feed is rebuilt whenever its channel reports failure — the
    // socket reconnects itself after a network drop or a realtime
    // service restart, but a channel that errored stays errored, and a
    // dead channel is indistinguishable from a quiet room. Each rebuild
    // takes a sequence number so a late status report from a torn-down
    // channel cannot trigger a rebuild loop.
    let unsubscribe = null;
    let resubTimer = null;
    let feedSeq = 0;
    const startFeed = () => {
      const mine = ++feedSeq;
      unsubscribe = Db.subscribeChatMessages({
        me: { id: currentUser.id, name: currentUser.name },
        onReaction: ({ messageId, profileId, emoji, on }) => {
          if (!live) return;
          // Identity matters: the rows are memoized on the message, and the
          // list on the array. Your own reaction comes straight back as an
          // echo already applied — handing back a fresh array for it
          // re-rendered the whole room a second time for nothing.
          setMessages(prev => {
            let hit = false;
            const next = prev.map(msg => {
              if (msg.id !== messageId) return msg;
              const cur = msg.reactions || [];
              const has = cur.some(r => r.profileId === profileId && r.emoji === emoji);
              if (on === has) return msg;
              hit = true;
              return {
                ...msg,
                reactions: on
                  ? [...cur, { emoji, profileId }]
                  : cur.filter(r => !(r.profileId === profileId && r.emoji === emoji))
              };
            });
            return hit ? next : prev;
          });
        },
        onPresence: people => {
          if (!live) return;
          setOthers(people.filter(p => p.profileId !== currentUser.id));
        },
        onInsert: m => {
          if (!live) return;
          const withName = named(m);
          setMessages(prev => {
            // A realtime row carries the reply pointer but not the quoted
            // join — the quoted message is almost always already on screen.
            let inc = withName;
            if (inc.replyTo && !inc.quoted) {
              const q = prev.find(x => x.id === inc.replyTo);
              if (q) {
                inc = { ...inc, quoted: {
                  id: q.id, name: q.name, body: q.body,
                  label: q.imageKey ? "(picture)" : q.gifUrl ? "(GIF)" : q.audioKey ? "(voice note)" : ""
                } };
              }
            }
            return mergeIn(prev, [inc]);
          });
          // A sender the directory doesn't know, or a quote of something
          // beyond the loaded page — one fetch fills either gap.
          if (!withName.name || (withName.replyTo && !withName.quoted)) {
            Db.getChatMessage(m.id)
              .then(full => { if (live && full) setMessages(prev => mergeIn(prev, [full])); })
              .catch(() => {});
          }
          // Reading the room as it happens keeps the badge honest on the
          // person's other devices. Debounced: a burst of five messages
          // is one bookmark move, not five upserts.
          // Only while the reader is at the bottom to watch it land — the
          // rule the poll path keeps: a message arriving while somebody
          // reads back through the morning used to zero the badges over
          // messages they had never scrolled to.
          if (stickToBottom.current && document.visibilityState === "visible") noteRead();
        },
        onUpdate: m => {
          if (!live) return;
          setMessages(prev => mergeIn(prev, [named(m)]));
          applyPinChange(m);
        },
        onDelete: id => {
          if (!live) return;
          setMessages(prev => prev.filter(m => m.id !== id));
          setPins(prev => prev.some(p => p.id === id) ? prev.filter(p => p.id !== id) : prev);
          // Don't leave the composer or the pin dialog pointed at a message
          // that no longer exists: a reply whose target was just deleted
          // would fail the reply_to FK on send with a misleading "couldn't
          // send that", and an open pin dialog would show a ghost.
          setReplyTarget(prev => (prev && prev.id === id ? null : prev));
          setPinView(prev => (prev && prev.id === id ? null : prev));
        },
        onStatus: status => {
          if (!live || mine !== feedSeq) return;
          feedLiveRef.current = status === "SUBSCRIBED";
          setFeedLive(feedLiveRef.current);
          if (status === "SUBSCRIBED") {
            // The feed healed on its own — a brief blip reconnects the same
            // channel and re-fires SUBSCRIBED. Cancel the pending resubscribe
            // or it fires 5s later and needlessly tears down a healthy feed
            // (a second or two of no live messages plus a redundant refresh).
            if (resubTimer) { clearTimeout(resubTimer); resubTimer = null; }
            // Whatever was said while the feed was down arrived nowhere —
            // pull it now rather than waiting out the poll interval.
            politeRefresh();
            return;
          }
          if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") && !resubTimer) {
            resubTimer = setTimeout(() => {
              resubTimer = null;
              if (!live) return;
              if (unsubscribe) unsubscribe();
              startFeed();
            }, 5000);
          }
        }
      });
    };
    startFeed();

    // One refresh, however many things ask for it at once: a phone
    // waking up fires focus AND visibilitychange, and the feed usually
    // reports SUBSCRIBED moments later — without the window that was
    // three identical fetches for one unlock.
    let lastPoll = 0;
    function politeRefresh() {
      const now = Date.now();
      if (now - lastPoll < 5000) return;
      lastPoll = now;
      loadLatest(false);
    }

    // While realtime is delivering, the poll is only a safety sweep and
    // runs every fourth tick; the moment the feed is down it is the
    // room's only pulse, and every tick counts again.
    let tick = 0;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      tick++;
      if (feedLiveRef.current && tick % 4 !== 0) return;
      politeRefresh();
    }, REFRESH_MS);
    const onFocus = () => politeRefresh();
    // Phones coming back from sleep fire visibilitychange, not focus —
    // and that return is exactly when the socket is most likely dead.
    const onVisible = () => { if (document.visibilityState === "visible") politeRefresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      live = false;
      if (resubTimer) clearTimeout(resubTimer);
      if (readTimer) clearTimeout(readTimer);
      if (unsubscribe) unsubscribe();
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // The preview URL belongs to the browser until it's given back.
  useEffect(() => () => { if (attach) URL.revokeObjectURL(attach.url); }, [attach]);

  // Instant for the room you walk into, eased for what arrives while
  // you watch — unless the device asked for stillness.
  const settled = useRef(false);
  const scrollBottom = smooth => {
    const el = listRef.current;
    if (!el) return;
    if (smooth && !motionOff()) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  };

  // One scroll rule for every way the list changes: restore the reader's
  // place after a prepend, follow the bottom if they were there — and if
  // they were up reading history when something new landed at the tail,
  // offer the way down instead of yanking them there.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const tail = messages.length ? messages[messages.length - 1].id : null;
    if (restoreHeight.current != null) {
      el.scrollTop += el.scrollHeight - restoreHeight.current;
      restoreHeight.current = null;
    } else if (stickToBottom.current) {
      scrollBottom(settled.current);
      if (!loading && messages.length) settled.current = true;
    } else if (tail && prevTail.current && tail !== prevTail.current) {
      setJumpChip(true);
    }
    prevTail.current = tail;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading]);

  // Pictures finish loading after the scroll rule has run and push the
  // list taller — follow them down if the reader was at the bottom.
  const restick = () => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  };

  // The bookmark move for reading the room by hand — scrolling back down
  // to the tail, or taking the "New messages" chip down. The same write
  // the feed's noteRead makes, without its debounce: this is one gesture.
  const readRoom = () => {
    if (document.visibilityState !== "visible") return;
    Db.markChatRead(currentUser.id)
      .then(() => { if (onReadRef.current) onReadRef.current(); })
      .catch(() => {});
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const wasUp = !stickToBottom.current;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    // Reaching the bottom retires the chip; setting an already-false
    // state is free, so no guard needed.
    if (stickToBottom.current) setJumpChip(false);
    // Coming back down to the tail is reading the room: an arrival while
    // they were reading back did not move the bookmark, and nothing else
    // would until they left the screen, so the badge sat lit over messages
    // on screen. Once per return to the bottom, the same write noteRead
    // makes.
    if (wasUp && stickToBottom.current) readRoom();
  };

  const loadOlder = async () => {
    const el = listRef.current;
    if (loadingOlder || !messages.length || !el) return;
    setLoadingOlder(true);
    try {
      const { messages: older, hasMore: more } = await Db.listChatMessages(messages[0].createdAt);
      older.forEach(m => { quietIds.current.add(m.id); });
      // Only when something was prepended: an empty page leaves the list
      // untouched, so the layout effect never runs to clear this, and the
      // stale height would throw the reader up the list at the next
      // arrival.
      if (older.length) restoreHeight.current = el.scrollHeight;
      setMessages(prev => mergeIn(prev, older));
      setHasMore(more);
    } catch (e) {
      setSendError(e.message || "Couldn't load earlier messages.");
    }
    setLoadingOlder(false);
  };

  const pickFile = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // so choosing the same photo again still fires
    if (!file) return;
    setSendError("");
    setAttach(prev => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { file, url: URL.createObjectURL(file) };
    });
  };

  const dropAttachment = () => {
    setAttach(prev => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  // Keep the held copy in step with the box, including the emptying a send
  // does — nothing should be offered back once it has gone out.
  useEffect(() => {
    holdDraft(currentUser.id, draft);
  }, [draft, currentUser.id]);
  // The rest of the composer the same way: a send or a × empties the state,
  // and the held copy follows it to empty.
  useEffect(() => {
    holdComposer(currentUser.id, { reply: replyTarget, attachFile: attach ? attach.file : null, voiceFile: voiceNote ? voiceNote.file : null });
  }, [replyTarget, attach, voiceNote, currentUser.id]);

  // Grow the composer with the message instead of scrolling a two-line slot:
  // 2,005 characters used to be typed through a 55 px window with a
  // scrollHeight of 763. Capped at about eight rows so the conversation above
  // never disappears behind the box; past that the textarea scrolls itself.
  const composerRef = useRef(null);
  // The ceiling — eight lines plus the frame — comes from .input's metrics,
  // which do not change while the screen is mounted, so it is measured
  // once: getComputedStyle on every keystroke was a forced style recalc
  // right before the reflow below.
  const composerMax = useRef(0);
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    if (!composerMax.current) {
      const cs = window.getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || 21;
      const frame = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
        .reduce((sum, p) => sum + (parseFloat(cs[p]) || 0), 0);
      composerMax.current = Math.round(line * 8 + frame);
    }
    const max = composerMax.current;
    // Measured from scratch each time, or deleting a paragraph leaves the box
    // as tall as the paragraph was.
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, max) + "px";
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft, recording, voiceNote]);

  const send = async () => {
    const text = draft.trim();
    if ((!text && !attach) || sending) return;
    setSending(true);
    setSendError("");
    try {
      const imageFile = attach ? await shrinkForChat(attach.file) : null;
      const sent = await Db.sendChatMessage(currentUser.id, text, {
        imageFile, replyTo: replyTarget ? replyTarget.id : null
      });
      // Clear only what went out. The composer stays live through the send
      // — shrinking and uploading a picture is not quick — so anything
      // typed meanwhile is sitting after the sent text and is not part of
      // the message; blanking the box wholesale swallowed it.
      setDraft(d => (d.startsWith(draft) ? d.slice(draft.length) : d));
      dropAttachment();
      setReplyTarget(null);
      stickToBottom.current = true;
      setMessages(prev => mergeIn(prev, [sent]));
      buzz();
    } catch (e) {
      // The draft and the picture stay in the composer — nothing was
      // said, nothing is lost.
      setSendError(e.message || "Couldn't send that — check the connection and try again.");
    }
    setSending(false);
  };

  // A GIF goes on its own once it has been chosen and confirmed; whatever
  // is typed in the composer stays there for its own send.
  const sendGif = async gifUrl => {
    if (sending) return;
    setSending(true);
    setSendError("");
    try {
      const sent = await Db.sendChatMessage(currentUser.id, "", {
        gifUrl, replyTo: replyTarget ? replyTarget.id : null
      });
      setGifOpen(false);
      setReplyTarget(null);
      stickToBottom.current = true;
      setMessages(prev => mergeIn(prev, [sent]));
      buzz();
    } catch (e) {
      setGifOpen(false);
      setSendError(e.message || "Couldn't send that GIF — check the connection and try again.");
    }
    setSending(false);
  };

  // Once, on arrival: where this device stands on notifications.
  useEffect(() => {
    let live = true;
    Db.getChatPushState()
      .then(s => { if (live) setPushState(s); })
      .catch(() => { if (live) setPushState("off"); });
    return () => { live = false; };
  }, []);

  // Enable-only: the switch hides itself once this device is subscribed
  // (turning notifications off again is the phone's own settings).
  const enablePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    setSendError("");
    try {
      await Db.enableChatPush();
      setPushState("on");
    } catch (e) {
      setSendError(e.message || "Couldn't turn notifications on.");
      // Permission may have just been denied for good — re-read reality.
      Db.getChatPushState().then(setPushState).catch(() => {});
    }
    setPushBusy(false);
  };

  // A short tick under the thumb when something goes out. Androids buzz;
  // iPhones ignore it silently, which is fine.
  const buzz = () => { if (navigator.vibrate) navigator.vibrate(10); };

  // Place or take back a reaction. Optimistic — the realtime echo and
  // the poll both agree with whatever the database settled on.
  const react = async (m, emoji) => {
    const had = (m.reactions || []).some(r => r.profileId === currentUser.id && r.emoji === emoji);
    setMessages(prev => prev.map(x => {
      if (x.id !== m.id) return x;
      const cur = x.reactions || [];
      return {
        ...x,
        reactions: had
          ? cur.filter(r => !(r.profileId === currentUser.id && r.emoji === emoji))
          : [...cur, { emoji, profileId: currentUser.id }]
      };
    }));
    buzz();
    try {
      await Db.setChatReaction(m.id, currentUser.id, emoji, !had);
    } catch (e) {
      setSendError(e.message || "Couldn't save that reaction.");
    }
  };

  // Share a file from the Files page: the message carries a reference,
  // never the file — the Files page keeps sole custody.
  const sendFile = async f => {
    if (sending) return;
    setSending(true);
    setSendError("");
    try {
      const sent = await Db.sendChatMessage(currentUser.id, "", {
        file: f, replyTo: replyTarget ? replyTarget.id : null
      });
      setFileOpen(false);
      setReplyTarget(null);
      stickToBottom.current = true;
      setMessages(prev => mergeIn(prev, [sent]));
      buzz();
    } catch (e) {
      setSendError(e.message || "Couldn't share that file — check the connection and try again.");
    }
    setSending(false);
  };

  // Opening a shared file mints its link at tap time, like the PDFs do —
  // into a tab claimed before the await. See openMinted in common.jsx for
  // why the old window.open with `noopener` also navigated the room away.
  const openSharedFile = async m => {
    try {
      await openMinted(() => Db.sharedFileUrl(m.fileKey));
    } catch (e) {
      setSendError(e.message || "Couldn't open that file — it may have been deleted from Files.");
    }
  };

  // Admin moderation: take a message out of the room.
  const remove = async id => {
    // The × sits a few pixels from the reactions in the same little menu,
    // and it deletes for the whole crew, not just this screen.
    if (!confirm("Delete this message for everyone? This can't be undone.")) return;
    try {
      await Db.deleteChatMessage(id);
      setMessages(prev => prev.filter(m => m.id !== id));
      setPins(prev => prev.some(p => p.id === id) ? prev.filter(p => p.id !== id) : prev);
      // Same scrub as the realtime onDelete — clear any composer reply or
      // pin dialog that was pointing at the message just removed.
      setReplyTarget(prev => (prev && prev.id === id ? null : prev));
      setPinView(prev => (prev && prev.id === id ? null : prev));
    } catch (e) {
      setSendError(e.message || "Couldn't remove that message.");
    }
  };

  // ── Voice notes ───────────────────────────────────────────────────────
  // Typing with gloves on is miserable; talking isn't. Tap Mic, talk, stop,
  // hear it back, send — capped at two minutes, which is a radio call, not
  // a podcast.
  const canRecord = typeof MediaRecorder !== "undefined" &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  const startRecording = async () => {
    if (recording || sending || voiceNote) return;
    setSendError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find(t => MediaRecorder.isTypeSupported(t)) || "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      recRef.current = { rec, stream, chunks, discard: false };
      rec.start();
      setRecording({ startedAt: Date.now() });
      setRecElapsed(0);
    } catch (_) {
      setSendError("Couldn't start recording — allow microphone access for the app and try again.");
    }
  };

  // Stopping never sends. The recording becomes a file sitting in the
  // composer with its own player, and Send is a second, deliberate tap.
  // Before this the two-minute ceiling called stopRecording(true) and the
  // note went out on its own: a tablet left recording in a pocket posted two
  // minutes of whatever it heard to the whole crew and push-notified every
  // phone, and deleting it afterwards does not un-buzz them.
  const stopRecording = keep => {
    const r = recRef.current;
    if (!r) return;
    r.discard = !keep;
    r.rec.onstop = () => {
      r.stream.getTracks().forEach(t => { t.stop(); });
      setRecording(null);
      recRef.current = null;
      if (r.discard || !r.chunks.length) return;
      const type = (r.rec.mimeType || "audio/webm").split(";")[0];
      const ext = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/ogg": "ogg" }[type] || "webm";
      const file = new File([new Blob(r.chunks, { type })], "voice-note." + ext, { type });
      setVoiceNote({ file, url: URL.createObjectURL(file) });
    };
    try { r.rec.stop(); } catch (_) { setRecording(null); recRef.current = null; }
  };

  const dropVoiceNote = () => setVoiceNote(null);

  const sendVoiceNote = async () => {
    if (!voiceNote || sending) return;
    setSending(true);
    setSendError("");
    try {
      const sent = await Db.sendChatMessage(currentUser.id, "", {
        audioFile: voiceNote.file, replyTo: replyTarget ? replyTarget.id : null
      });
      setVoiceNote(null);
      setReplyTarget(null);
      stickToBottom.current = true;
      setMessages(prev => mergeIn(prev, [sent]));
      buzz();
    } catch (e) {
      // The note stays in the composer, so a failed send is a retry rather
      // than a recording to make again.
      setSendError(e.message || "Couldn't send the voice note — check the connection and try again.");
    }
    setSending(false);
  };

  // One place that lets a note's object URL go: the cleanup runs when the
  // note is replaced, discarded, sent, or the screen closes over it.
  useEffect(() => {
    if (!voiceNote) return undefined;
    return () => URL.revokeObjectURL(voiceNote.url);
  }, [voiceNote]);

  // The elapsed readout, and the two-minute ceiling — which stops the
  // microphone and holds what it has.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const s = Math.floor((Date.now() - recording.startedAt) / 1000);
      setRecElapsed(s);
      if (s >= 120) stopRecording(true);
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  // Leaving the screen mid-recording releases the microphone.
  useEffect(() => () => {
    const r = recRef.current;
    if (r) {
      r.discard = true;
      try { r.rec.stop(); } catch (_) { /* already stopped */ }
      r.stream.getTracks().forEach(t => { t.stop(); });
    }
  }, []);

  // ── Job links ─────────────────────────────────────────────────────────
  // A word in a message that matches a real job number opens that job.
  // Membership, not pattern: job numbers here are freeform ("6969",
  // "J-5001"), so the only reliable test is "is it actually one".
  const openJobNumber = async num => {
    try {
      const job = await Db.getJobByNumber(num);
      if (job && onOpenJob) onOpenJob(job);
      else setSendError("No job by that number any more.");
    } catch (_) {
      setSendError("No job by that number any more.");
    }
  };

  // Full screen for any message's picture or GIF. A stored picture gets
  // a fresh signed URL at tap time — the one its thumbnail was minted
  // with may be minutes old, and an expired link at full screen is a
  // broken image, not a picture.
  const openImage = async m => {
    try {
      const src = m.gifUrl || await Db.signedUrl("chat-media", m.imageKey, { fresh: true });
      setLightbox(src);
    } catch (e) {
      setSendError(e.message || "Couldn't open the picture.");
    }
  };

  const togglePin = async m => {
    try {
      if (m.pinnedAt) await Db.unpinChatMessage(m.id);
      else await Db.pinChatMessage(m.id, currentUser.id);
      const flipped = { ...m, pinnedAt: m.pinnedAt ? null : new Date().toISOString() };
      setMessages(prev => mergeIn(prev, [flipped]));
      applyPinChange(flipped);
    } catch (e) {
      setSendError(e.message || "Couldn't change that pin.");
    }
  };

  const isAdmin = currentUser.role === "Admin";
  const muted = MUTED;
  const tinyBtn = TINY_BTN;

  // The handlers the rows call, read through one ref so a row's memo never
  // sees a new function identity (see ChatRow).
  const rowHandlers = useRef({});
  rowHandlers.current = { react, remove, togglePin, setReplyTarget, setMenuFor, openImage, openSharedFile, restick, openJobNumber };


  // The room's rows: day dividers, the "new messages" mark and one ChatRow
  // per message. Rebuilt when the room does — messages, the unread mark,
  // the job dictionary, an open ⋯ menu — and not on a keystroke in the
  // composer; and cheap now that each row is memoized on its own props,
  // so a rebuild here re-renders only the rows whose props moved. What
  // stays in this loop is sequential: where the dividers go and which
  // message starts a run.
  const messageRows = useMemo(() => {
    const rows = [];
    let prevMsg = null;
    let prevDayKey = "";
    let markPlaced = false;
    const today = dayStamp;
    for (const m of messages) {
      const d = new Date(m.createdAt);
      const dayKey = d.toDateString();
      if (dayKey !== prevDayKey) {
        rows.push(
          <div key={"day-" + dayKey} style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 4px", fontSize: 11, color: muted }}>
            <span style={{ flex: 1, borderTop: "1px solid var(--color-divider)" }} />
            {dayKey === today ? "Today" : d.toLocaleDateString("en-CA", { weekday: "long", day: "numeric", month: "short" })}
            <span style={{ flex: 1, borderTop: "1px solid var(--color-divider)" }} />
          </div>
        );
        prevDayKey = dayKey;
        prevMsg = null;
      }
      if (!markPlaced && entryMark && m.createdAt > entryMark && m.profileId !== currentUser.id) {
        rows.push(
          <div key="new-mark" style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0 4px", fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--color-accent)" }}>
            <span style={{ flex: 1, borderTop: "1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)" }} />
            New messages
            <span style={{ flex: 1, borderTop: "1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)" }} />
          </div>
        );
        markPlaced = true;
        prevMsg = null;
      }

      const mine = m.profileId === currentUser.id;
      // A chip-and-time line starts each run of messages: a new sender,
      // or the same one back after half an hour away.
      const newRun = !prevMsg || prevMsg.profileId !== m.profileId ||
        new Date(m.createdAt) - new Date(prevMsg.createdAt) > 30 * 60000;
      rows.push(
        <ChatRow key={m.id} m={m} mine={mine} newRun={newRun}
          quiet={quietIds.current.has(m.id)} menuOpen={menuFor === m.id}
          isAdmin={isAdmin} uid={currentUser.id} jobNums={jobNums} h={rowHandlers} />
      );
      prevMsg = m;
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isAdmin, currentUser.id, jobNums, entryMark, menuFor, dayStamp]);

  return (
    <div className="page chat-page" style={{ maxWidth: 760 }}>
      <Blueprint className="chat-card">
        {others.length > 0 && (
          <div style={{ borderBottom: "1px solid var(--color-divider)", padding: "6px 16px", display: "flex", alignItems: "center", gap: 6, flex: "none", fontSize: 11, color: muted }}>
            Here now
            {others.map(p => {
              const hue = chipHue(p.profileId);
              return (
                <span key={p.profileId} title={p.name || "Someone"} style={{
                  width: 20, height: 20, display: "grid", placeItems: "center",
                  fontSize: 9, fontWeight: 700, color: hue,
                  background: `color-mix(in srgb, ${hue} 20%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${hue} 45%, transparent)`
                }}>
                  {initialsOf(p.name || "").slice(0, 2) || "•"}
                </span>
              );
            })}
          </div>
        )}
        {pins.length > 0 && (
          <div style={{
            borderBottom: "1px solid var(--color-divider)", padding: "10px 16px",
            maxHeight: 150, overflowY: "auto", flex: "none",
            background: "color-mix(in srgb, var(--color-accent) 5%, transparent)"
          }}>
            <div className="kicker" style={{ marginBottom: 6 }}>Pinned</div>
            {pins.map(p => (
              <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 4 }}>
                {/* The whole row opens the full post — a strip line is a
                    headline, not the story. Only the unpin × stays its
                    own control. */}
                <button
                  onClick={() => setPinView(p)}
                  title="Open the full message"
                  style={{ display: "flex", gap: 8, alignItems: "center", flex: 1, minWidth: 0, padding: 0, background: "transparent", border: "none", cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left" }}
                >
                  <span style={{ color: muted, flex: "none" }}>{p.name || "Someone"}:</span>
                  {(p.imageKey || p.gifUrl) && <PinThumb pin={p} onOpen={() => setPinView(p)} />}
                  <span
                    style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {p.body || (p.audioKey ? "(voice note)" : "") || p.fileName || ""}
                  </span>
                </button>
                {isAdmin && (
                  <button onClick={() => togglePin(p)} aria-label="Take this pin down" title="Take this pin down"
                    style={{ ...tinyBtn, fontSize: 15, flex: "none" }}>
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div ref={listRef} onScroll={onScroll} style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain", padding: "16px 16px 8px" }}>
          {loading ? (
            // Ghost bubbles instead of a spinner: the room's shape,
            // arriving before its words.
            <div role="status" aria-label="Loading the chat">
              {[0, 1, 2, 3, 4].map(i => (
                <div key={i} style={{ display: "flex", justifyContent: i % 2 ? "flex-end" : "flex-start", marginTop: i ? 14 : 4 }}>
                  <div className="chat-skel" style={{ width: 120 + ((i * 53) % 140), height: 38 }} />
                </div>
              ))}
            </div>
          ) : loadError ? (
            <ErrorBox>{loadError}</ErrorBox>
          ) : (
            <>
              {hasMore && (
                <div style={{ textAlign: "center", marginBottom: 12 }}>
                  <Btn variant="secondary" onClick={loadOlder} disabled={loadingOlder}>
                    {loadingOlder ? "Loading…" : "Show earlier messages"}
                  </Btn>
                </div>
              )}
              {messages.length === 0 && (
                <div style={{ color: muted, textAlign: "center", padding: "40px 0" }}>
                  <div aria-hidden="true" style={{
                    width: 150, height: 32, margin: "0 auto 12px",
                    background: "currentColor", opacity: 0.45,
                    WebkitMaskImage: "url(/brand/wordmark.svg)", maskImage: "url(/brand/wordmark.svg)",
                    WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
                    WebkitMaskPosition: "center", maskPosition: "center",
                    WebkitMaskSize: "contain", maskSize: "contain"
                  }} />
                  Nothing here yet — say hello.
                </div>
              )}
              {messageRows}
              {jumpChip && (
                <div style={{ position: "sticky", bottom: 4, textAlign: "center", marginTop: 8 }}>
                  <button
                    onClick={() => {
                      stickToBottom.current = true;
                      setJumpChip(false);
                      scrollBottom(true);
                      // Taking the chip down is reading the room too, and
                      // onScroll cannot write it: the stick is already set,
                      // so its wasUp is false by the time the scroll fires.
                      readRoom();
                    }}
                    style={{
                      fontSize: 12, fontWeight: 600, cursor: "pointer",
                      padding: "6px 14px", border: "1px solid var(--color-accent)",
                      background: "var(--color-bg)", color: "var(--color-accent)"
                    }}>
                    ↓ New messages
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--color-divider)", padding: 12, flex: "none" }}>
          {sendError && <div style={{ marginBottom: 8 }}><ErrorBox>{sendError}</ErrorBox></div>}
          {attach && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <img src={attach.url} alt="Ready to send" style={{ height: 56, maxWidth: 120, objectFit: "cover", border: "1px solid var(--color-divider)" }} />
              <span style={{ fontSize: 12, color: muted, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {attach.file.name}
              </span>
              <button onClick={dropAttachment} aria-label="Remove the picture" title="Remove the picture" style={{ ...tinyBtn, fontSize: 15 }}>×</button>
            </div>
          )}
          {replyTarget && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12, borderLeft: "2px solid color-mix(in srgb, var(--color-accent) 55%, transparent)", paddingLeft: 8 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Replying to <span style={{ color: "var(--color-accent)", fontWeight: 600 }}>{replyTarget.name || "Someone"}</span>
                <span style={{ color: muted }}> — {replyTarget.body || (replyTarget.imageKey ? "(picture)" : replyTarget.gifUrl ? "(GIF)" : replyTarget.audioKey ? "(voice note)" : "")}</span>
              </span>
              <button onClick={() => setReplyTarget(null)} aria-label="Cancel the reply" title="Cancel the reply" style={{ ...tinyBtn, fontSize: 15 }}>×</button>
            </div>
          )}
          {/* A finished recording, with the player it is listened back on.
              Send is a separate tap from Stop on purpose: what goes into the
              room buzzes every phone in the crew. */}
          {voiceNote && !recording && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <audio controls src={voiceNote.url} style={{ height: 36, flex: "1 1 190px", minWidth: 150 }} />
              <Btn variant="secondary" onClick={dropVoiceNote} disabled={sending}>Discard</Btn>
              <Btn variant="primary" onClick={sendVoiceNote} disabled={sending}>{sending ? "Sending…" : "Send voice note"}</Btn>
            </div>
          )}
          {recording ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: "var(--color-accent)", fontWeight: 600, fontVariantNumeric: "tabular-nums", flex: "none" }}>
                ● {Math.floor(recElapsed / 60)}:{String(recElapsed % 60).padStart(2, "0")}
              </span>
              <span style={{ fontSize: 12, color: muted, flex: 1 }}>Recording — stops itself at two minutes, and waits for you to send it.</span>
              <Btn variant="secondary" onClick={() => stopRecording(false)}>Cancel</Btn>
              <Btn variant="primary" onClick={() => stopRecording(true)}>Stop</Btn>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <input ref={fileRef} type="file" accept="image/*" onChange={pickFile} style={{ display: "none" }} />
              <Btn variant="secondary" onClick={() => fileRef.current && fileRef.current.click()} disabled={sending}
                title="Attach a picture" aria-label="Attach a picture" style={composerBtnStyle}>
                <IconPhoto />
              </Btn>
              <Btn variant="secondary" onClick={() => setGifOpen(true)} disabled={sending}
                title="Search and send a GIF" aria-label="Search and send a GIF" style={composerBtnStyle}>
                GIF
              </Btn>
              <Btn variant="secondary" onClick={() => setFileOpen(true)} disabled={sending}
                title="Share a file from the Files page" aria-label="Share a file from the Files page" style={composerBtnStyle}>
                <IconClip />
              </Btn>
              {canRecord && (
                <Btn variant="secondary" onClick={startRecording} disabled={sending || !!voiceNote}
                  title="Record a voice note" aria-label="Record a voice note" style={composerBtnStyle}>
                  <IconMic />
                </Btn>
              )}
              <textarea
                ref={composerRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  // Enter sends; Shift+Enter makes a line break.
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                }}
                placeholder="Message the crew…"
                rows={2}
                maxLength={DRAFT_MAX}
                className="input"
                style={{ flex: 1, minWidth: 160, resize: "none", minHeight: 46, lineHeight: 1.45 }}
              />
              <Btn variant="primary" onClick={send} disabled={sending || (!draft.trim() && !attach)}
                title="Send" aria-label="Send" style={{ padding: "10px 14px" }}>
                <IconSend />
              </Btn>
            </div>
          )}
          {/* Quiet until the limit is close: a counter on every message is
              noise, but running into 4,000 with nothing said is a box that
              stops taking keys for no visible reason. Always rendered and
              hidden, like ErrorBox, because a node that appears out of
              nothing is announced less reliably than one that changes. */}
          <div aria-live="polite" hidden={!!recording || draft.length <= DRAFT_WARN_FROM}
            style={{ fontSize: 11, color: "var(--color-accent-700)", marginTop: 6 }}>
            {DRAFT_MAX - draft.length} characters left.
          </div>
          {/* Said here because history quietly ending mid-scroll would
              otherwise read as a bug, not a policy — and likewise a live
              feed that is down reconnecting should say so, not just go
              quiet. One line, never wrapping: the text swapping was
              re-wrapping this line on phones, and the whole message pane
              pumped up and down with it. Truncation beats jitter. */}
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 45%, transparent)", marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {loading || feedLive
              ? "Messages clear after 30 days — pinned messages stay."
              : "Live updates connecting — the room refreshes every 30 seconds meanwhile."}
          </div>
        </div>
      </Blueprint>
      {/* Below the room rather than in it: settings are not conversation.
          Shown only while there is something to do — a device that can't
          push (an iPhone not installed to the home screen) never sees it,
          and a device already subscribed is done with it. Turning
          notifications back off is the phone's own settings; a blocked
          permission invalidates the subscription, and the sender prunes
          it on the next push. */}
      {pushState !== "unsupported" && pushState !== "on" && (
        <div style={{ marginTop: 14, opacity: pushBusy ? 0.6 : 1 }}>
          <Switch on={false} onClick={enablePush} label="Notify me about new messages" />
          <div style={{ fontSize: 12, color: muted, marginTop: 4, maxWidth: 520 }}>
            Sends a notification to this device when someone posts in the team chat — even with the
            app closed. The switch is per device: turn it on on every phone or tablet that should buzz.
          </div>
        </div>
      )}
      {gifOpen && <GifPicker onPick={sendGif} onClose={() => setGifOpen(false)} busy={sending} />}
      {fileOpen && <FilePickerDialog onPick={sendFile} onClose={() => setFileOpen(false)} busy={sending} />}
      {pinView && (
        <Dialog
          title="Pinned message"
          maxWidth={520}
          onClose={() => setPinView(null)}
          actions={<>
            {isAdmin && (
              <Btn variant="secondary" onClick={() => { setPinView(null); togglePin(pinView); }}>
                Unpin
              </Btn>
            )}
            <Btn variant="primary" onClick={() => setPinView(null)}>Close</Btn>
          </>}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span aria-hidden="true" style={{
              width: 24, height: 24, display: "grid", placeItems: "center", flex: "none",
              fontSize: 10, fontWeight: 700,
              color: chipHue(pinView.profileId),
              background: `color-mix(in srgb, ${chipHue(pinView.profileId)} 20%, transparent)`,
              border: `1px solid color-mix(in srgb, ${chipHue(pinView.profileId)} 45%, transparent)`
            }}>
              {initialsOf(pinView.name || "").slice(0, 2) || "•"}
            </span>
            <span style={{ fontWeight: 600 }}>{pinView.name || "Someone"}</span>
            <span style={{ fontSize: 12, color: muted }}>{pinView.at}</span>
          </div>
          {pinView.quoted && (
            <div style={{
              marginBottom: 10, padding: "4px 8px", fontSize: 12,
              borderLeft: "2px solid color-mix(in srgb, var(--color-accent) 55%, transparent)",
              background: "color-mix(in srgb, var(--color-text) 5%, transparent)"
            }}>
              <span style={{ color: "var(--color-accent)", fontWeight: 600 }}>{pinView.quoted.name || "Someone"}</span>
              <span style={{ color: muted }}> — {pinView.quoted.body || pinView.quoted.label}</span>
            </div>
          )}
          {pinView.gifUrl && (
            <img src={pinView.gifUrl} alt="GIF" onClick={() => openImage(pinView)}
              style={{ display: "block", maxWidth: "100%", maxHeight: 320, cursor: "zoom-in", marginBottom: 10 }} />
          )}
          {pinView.imageKey && (
            <div style={{ marginBottom: 10 }}>
              <ChatImage imageKey={pinView.imageKey} onOpen={() => openImage(pinView)} />
            </div>
          )}
          {pinView.audioKey && (
            <div style={{ marginBottom: 10 }}>
              <ChatAudio audioKey={pinView.audioKey} />
            </div>
          )}
          {pinView.fileKey && (
            <button onClick={() => openSharedFile(pinView)}
              title="Open this file from the Files page"
              style={{ display: "flex", alignItems: "center", gap: 8, padding: 0, marginBottom: 10, background: "transparent", border: "none", cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left", maxWidth: "100%" }}>
              <span style={{ flex: "none", fontSize: 9, fontWeight: 700, letterSpacing: ".06em", padding: "3px 5px", border: "1px solid color-mix(in srgb, var(--color-accent) 55%, transparent)", color: "var(--color-accent)" }}>
                {(pinView.fileName.split(".").pop() || "file").toUpperCase().slice(0, 4)}
              </span>
              <span style={{ textDecoration: "underline", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {pinView.fileName}
              </span>
            </button>
          )}
          {pinView.body && (
            <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {renderBody(pinView.body, jobNums, openJobNumber)}
            </div>
          )}
        </Dialog>
      )}
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
