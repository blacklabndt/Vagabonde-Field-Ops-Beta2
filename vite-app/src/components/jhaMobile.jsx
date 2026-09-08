import React, { useState, useEffect, useRef } from "react";
import { JHA_TEMPLATES, SEED_HAZARDS, todayLocal, localDate, dayMonth, storageKeySafe } from "../data.js";
import { Db } from "../db.js";
import { acceptsNumberText } from "../numberInput.js";
import { Blueprint, Btn, CheckBox, TagX, Field, Dialog, ErrorBox, Switch, splitContact, hazardTagVariant, NoJobSelected, ConnectionBar, QueuedPanel, useMissingFields, useScreenFoot } from "./common.jsx";
import { OfflineQueue } from "../offlineQueue.js";
import { OfflineCache } from "../offlineCache.js";
import { hasNoSerials, isMissingSetOwnDosimetry, newSerials, mergedSerials, dosimetryAskedFor, markDosimetryAsked } from "../dosimetryPrompt.js";
import { savingLabel, deviceOffline } from "../savingWords.js";

// The JHA (FLHA) — filed at the start of the day, closed out at the end.
//
// It follows the paper form: site information, the hazard worksheet with a
// severity / probability / frequency rating per hazard, the equipment record,
// and the two nuclear energy workers with their dosimetry. Hand signatures are
// deliberately not collected — the account that files it is the record of who
// filed it.
//
// Readings: start is always 0, so the end reading IS the dose. End readings
// don't exist yet when this is filed, which is why the assessment stays Open
// until someone closes it out (see JhaCloseOutDialog in jobDetail).

const COMM_PRESETS = ["Phone", "Road Radio"];
const HOSPITAL_DEFAULT = "Grande Prairie Regional Hospital — 11205 110 St, Grande Prairie, AB";
const BLANK_SITE = { weather: "", temperature: "", communication: "", commOther: false, muster: "", hospital: HOSPITAL_DEFAULT, firstAid: "" };
// PPE opens unticked, like the hazards do (SEED_HAZARDS in data.js). Hard hat,
// glasses and boots used to arrive already ticked, so the equipment record
// claimed three pieces of PPE nobody had confirmed they had on.
const BLANK_EQUIP = {
  ppe: { hardHat: false, glasses: false, boots: false, fr: false, gloves: false },
  h2sSerial: "", h2sBumpTest: false,
  redSerial: "", redSurveyMr: "", collimator: false, emergencyKit: false
};

const BLANK_KIT = { unit: "", idCode: "", tld: "", drd: "", alarm: "" };

const PPE_CHECKS = [
  { key: "hardHat", label: "Hard hat" },
  { key: "glasses", label: "Safety glasses" },
  { key: "boots", label: "Steel toe boots" },
  { key: "fr", label: "FR coveralls" },
  { key: "gloves", label: "Gloves" }
];

// Severity, probability and frequency are each 1–3 on the form; their sum is
// the priority, banded low / medium / high.
const RATING_SCALE = [1, 2, 3];
function priorityOf(r) {
  const total = (r.s || 0) + (r.p || 0) + (r.f || 0);
  return { total, band: total <= 5 ? "Low" : total <= 7 ? "Med" : "High" };
}

export function JhaBuilderScreen({ job, jobRecord, currentUser, onSubmitted, onCancel }) {
  const [hazards, setHazards] = useState(() => SEED_HAZARDS.map(h => ({ ...h })));
  const [extra, setExtra] = useState([]);
  const [ratings, setRatings] = useState({});
  // The site rep is usually whoever the job's contractor rep is — default to
  // them; the second box adds another name alongside it (more than one
  // person on site reviewing the JHA), rather than swapping the first out.
  const [siteRep, setSiteRep] = useState(() => splitContact((jobRecord || {}).contractorRep).name);
  const [siteRepOther, setSiteRepOther] = useState("");
  const [saving, setSaving] = useState(false);
  // How long the filing on screen has been waiting, which is what decides the
  // button's wording (savingLabel). Measured from a start stamp rather than
  // counted in ticks, because a phone that dims its screen throttles the
  // interval and a tick count would report a wait shorter than it was. Up
  // here with every other hook, above the early returns further down.
  const [savingMs, setSavingMs] = useState(0);
  useEffect(() => {
    if (!saving) { setSavingMs(0); return undefined; }
    const startedAt = Date.now();
    const id = setInterval(() => setSavingMs(Date.now() - startedAt), 250);
    return () => clearInterval(id);
  }, [saving]);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(false);
  useScreenFoot(!!job && !queued);
  // An idempotency key for this one assessment (jhas.client_key), minted
  // once, kept with the recovery copy and sent with the outbox payload, so
  // a filing whose answer was lost on the radio is found again rather than
  // filed twice as two signed safety records for the same day.
  const [clientKey, setClientKey] = useState(() => (crypto.randomUUID ? crypto.randomUUID() : null));
  // What this person rated each hazard last time (loaded below, merged under
  // the live ratings). Declared up here because the "anything entered?"
  // guard compares against it, and a const read before its declaration is a
  // crash on the first render — which is exactly what the builder did for
  // half an hour after round three shipped, until the e2e suite said so.
  const [remembered, setRemembered] = useState({});
  const miss = useMissingFields();

  // The day this assessment covers. Defaults to today, because that is what
  // it almost always is — but a JHA that got missed on site and is being
  // written up afterwards has to be able to say which day it was for, or the
  // record (and the PDF) claims the wrong one.
  const [workDate, setWorkDate] = useState(todayLocal);
  const backdated = workDate !== todayLocal();

  const [site, setSite] = useState(BLANK_SITE);
  const [equip, setEquip] = useState(BLANK_EQUIP);

  // Worker (1) is whoever is filing. Worker (2) is the helper with them, if
  // there is one — picked from the crew so their own equipment comes along.
  const [people, setPeople] = useState([]);
  const [helperId, setHelperId] = useState("");
  const [w1, setW1] = useState({ unit: "", idCode: "", tld: "", drd: "", alarm: "" });
  // Whether the tech has hand-edited worker (1)'s kit. Once they have, the
  // auto-derive effect below must not overwrite it — a corrected DRD or
  // alarm serial typed before the crew/equipment lists land would otherwise
  // be silently replaced by the default the moment those fetches resolve,
  // and the JHA's PDF would record the wrong dosimeter serial.
  const w1Touched = useRef(false);
  const editW1 = next => { w1Touched.current = true; setW1(next); };
  const [w2, setW2] = useState({ unit: "", idCode: "", tld: "", drd: "", alarm: "" });
  // The same guard for worker (2): a serial corrected by hand must survive
  // the equipment list landing a moment later. Picking a different helper
  // starts that person's kit fresh.
  const w2Touched = useRef(false);
  const editW2 = next => { w2Touched.current = true; setW2(next); };
  const w2For = useRef("");
  const [equipment, setEquipment] = useState([]);
  // Whether the equipment list has answered. An empty array is both "nothing
  // assigned" and "hasn't landed yet", and the offer below must not be made
  // off a kit that is only half-derived — a tech with an assigned TLD would
  // be told their profile is empty for the second or two before the fetch
  // resolves.
  const [equipReady, setEquipReady] = useState(false);
  // The one-off offer to put this worker's serials on their own profile.
  // `keepable` goes false when the database has no set_own_dosimetry yet:
  // pressing again would fail the same way, so the panel keeps the message
  // and drops the button.
  // "" for no offer, "none" when the profile holds no serial at all, "new"
  // when a serial has been typed that the profile does not hold.
  const [askDosimetry, setAskDosimetry] = useState("");
  const [keeping, setKeeping] = useState(false);
  const [keepMsg, setKeepMsg] = useState("");
  const [keepable, setKeepable] = useState(true);

  // ── Don't lose a half-built assessment ───────────────────────────────
  // The ticket screen keeps a copy of what is being typed; this didn't, and
  // fifteen rated hazards went with any tap on the drawer, an update
  // restart, or a phone evicting the tab. Keyed by job, kept as it is
  // typed, offered back on return, dropped once filed or discarded.
  const wipKey = job && job.dbId ? `jha.wip.${job.dbId}` : null;
  const wipReady = useRef(false);
  const [recovered, setRecovered] = useState(null);
  const dropWip = () => {
    if (!wipKey) return;
    try { const p = OfflineCache.remove(wipKey); if (p && p.catch) p.catch(() => {}); } catch { /* nothing to drop */ }
  };

  // ── Day two of a job starts where day one left off ─────────────────────
  // Muster point, communication, hospital, first aid, the H₂S serial and the
  // kit switches are the same on the same lease the next morning, and were
  // being retyped every day of a multi-day job. They come from the job's
  // most recent assessment — only into boxes still blank, so a tech who
  // typed first keeps what they typed — and the form says where they came
  // from. Weather, temperature, the survey reading and the bump test are
  // today's facts and start empty. `baseline` is what the prefill wrote, so
  // the recovery copy counts only what the person changed themselves.
  const [prefilledFrom, setPrefilledFrom] = useState(null);
  const baseline = useRef({ site: BLANK_SITE, equip: BLANK_EQUIP });
  // What the form holds right now, readable from inside the fetch's callback
  // without a stale closure — a box typed into before the last assessment
  // arrives keeps what was typed.
  const siteRef = useRef(site); siteRef.current = site;
  const equipRef = useRef(equip); equipRef.current = equip;
  const prefillFromLastJha = () => {
    if (!job || !job.dbId) return;
    Db.lastJhaDetailsForJob(job.dbId).then(last => {
      if (!last || (!last.site && !last.equipment)) return;
      const ls = last.site || {}, le = last.equipment || {};
      const p = siteRef.current, e = equipRef.current;
      const nextSite = {
        ...p,
        communication: p.communication || ls.communication || "",
        commOther: p.communication ? p.commOther : !!(ls.communication && !COMM_PRESETS.includes(ls.communication)),
        muster: p.muster || ls.muster || "",
        hospital: p.hospital === HOSPITAL_DEFAULT && ls.hospital ? ls.hospital : p.hospital,
        firstAid: p.firstAid || ls.firstAid || ""
      };
      const nextEquip = {
        ...e,
        h2sSerial: e.h2sSerial || le.h2sSerial || "",
        collimator: e.collimator || !!le.collimator,
        emergencyKit: e.emergencyKit || !!le.emergencyKit
      };
      baseline.current = { site: nextSite, equip: nextEquip };
      setSite(nextSite);
      setEquip(nextEquip);
      setPrefilledFrom(last.workDate || true);
    }).catch(() => { /* first assessment on this job, or no signal and nothing cached */ });
  };

  useEffect(() => {
    if (!wipKey) return;
    let live = true;
    OfflineCache.read(wipKey).then(hit => {
      if (!live) return;
      const w = hit && hit.value;
      if (!(w && w.entered)) prefillFromLastJha();
      if (w && w.entered) {
        if (w.hazards) setHazards(w.hazards);
        if (w.extra) setExtra(w.extra);
        if (w.ratings) setRatings(prev => ({ ...prev, ...w.ratings }));
        if (w.siteRep != null) setSiteRep(w.siteRep);
        if (w.siteRepOther != null) setSiteRepOther(w.siteRepOther);
        if (w.workDate) setWorkDate(w.workDate);
        if (w.site) setSite(w.site);
        if (w.equip) setEquip(w.equip);
        if (w.helperId != null) { w2For.current = w.helperId; setHelperId(w.helperId); }
        if (w.w1) { w1Touched.current = true; setW1(w.w1); }
        if (w.w2) { w2Touched.current = true; setW2(w.w2); }
        if (w.clientKey) setClientKey(w.clientKey);
        setRecovered(hit.at || null);
      }
      wipReady.current = true;
    }).catch(() => { wipReady.current = true; });
    return () => { live = false; };
  }, [wipKey]);
  // Only what someone actually entered is worth keeping — the defaults, the
  // remembered ratings, a derived kit and what the last assessment prefilled
  // are not.
  const sameAs = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Against the seed, not "anything ticked". The two answer the same on an
  // untouched form now that the standard hazards open unticked, and they part
  // company again the moment a hazard is unticked after being ticked — which
  // is an edit, and a form with edits on it is worth keeping.
  const entered = !sameAs(hazards, SEED_HAZARDS) || extra.length > 0
    || !sameAs(ratings, remembered)
    || !sameAs(site, baseline.current.site)
    || !sameAs({ ...equip, redSerial: "" }, { ...baseline.current.equip, redSerial: "" })
    || !!siteRepOther.trim()
    || w1Touched.current || w2Touched.current;
  useEffect(() => {
    if (!wipKey || !wipReady.current) return;
    if (!entered) { dropWip(); return; }
    const t = setTimeout(() => {
      OfflineCache.put(wipKey, {
        entered: true, hazards, extra, ratings, siteRep, siteRepOther, workDate, site, equip, helperId, clientKey,
        w1: w1Touched.current ? w1 : null, w2: w2Touched.current ? w2 : null
      });
    }, 700);
    return () => clearTimeout(t);
  }, [hazards, extra, ratings, siteRep, siteRepOther, workDate, site, equip, helperId, w1, w2]);
  const discardRecovered = () => {
    dropWip();
    setRecovered(null);
    // A fresh assessment is a fresh filing: a new key, so it can never be
    // taken for the one that was thrown away.
    setClientKey(crypto.randomUUID ? crypto.randomUUID() : null);
    setHazards(SEED_HAZARDS.map(h => ({ ...h })));
    setExtra([]);
    setRatings({ ...remembered });
    setSiteRep(splitContact((jobRecord || {}).contractorRep).name);
    setSiteRepOther("");
    setWorkDate(todayLocal());
    setSite(BLANK_SITE);
    setEquip(BLANK_EQUIP);
    setHelperId("");
    w1Touched.current = false;
    w2Touched.current = false;
    const me = people.find(p => p.id === currentUser.id);
    setW1(me ? kitOf(me, equipment) : BLANK_KIT);
    baseline.current = { site: BLANK_SITE, equip: BLANK_EQUIP };
    setPrefilledFrom(null);
    prefillFromLastJha();
  };

  useEffect(() => {
    // Ready either way: a list that failed to load leaves the profile's own
    // columns as the whole story of this person's kit, which is the honest
    // basis for asking them about it.
    Db.listEquipment()
      .then(list => { setEquipment(list); setEquipReady(true); })
      .catch(e => { setEquipReady(true); console.error("Couldn't load equipment assignments:", e.message); });
  }, []);

  // Start each hazard at whatever this person rated it last time. Merged
  // *under* anything already set, so a rating changed on this form is never
  // overwritten by the defaults arriving a moment later. (`remembered` is
  // declared with the other state at the top.)
  useEffect(() => {
    Db.lastHazardRatings(currentUser.id)
      .then(defaults => {
        setRemembered(defaults);
        setRatings(prev => {
          const merged = { ...prev };
          for (const [name, rating] of Object.entries(defaults)) {
            merged[name] = { ...rating, ...(prev[name] || {}) };
          }
          return merged;
        });
      })
      .catch(e => console.warn("Couldn't load your previous hazard ratings:", e.message));
  }, [currentUser.id]);

  useEffect(() => {
    Db.listActiveProfiles().then(setPeople)
      .catch(e => console.error("Couldn't load the crew list:", e.message));
  }, []);

  // Worker (1)'s kit, re-derived when either half of it arrives. Kept apart
  // from the fetch above so the equipment list landing doesn't re-request the
  // crew list along with it.
  useEffect(() => {
    if (w1Touched.current) return;
    const me = people.find(p => p.id === currentUser.id);
    if (me) setW1(kitOf(me, equipment));
  }, [people, equipment, currentUser.id]);

  // Offer, once, to put the serials on the profile of whoever is filing.
  // A technician with none of the three cannot file at all until they type
  // one, and nothing they can reach has ever written it back — so the same
  // three numbers were typed again on the next job, and the one after. Asked
  // only when both lists have answered and the kit really is empty, and only
  // once per person per session (dosimetryPrompt.js, cleared when the session ends): the panel is a help,
  // not a gate, and the form works exactly as before if it is dismissed.
  useEffect(() => {
    if (!equipReady || dosimetryAskedFor(currentUser.id)) return;
    const me = people.find(p => p.id === currentUser.id);
    if (!me || !hasNoSerials(kitOf(me, equipment))) return;
    markDosimetryAsked(currentUser.id);
    setAskDosimetry("none");
  }, [people, equipment, equipReady, currentUser.id]);

  // The other offer: a serial typed that is not on file — the worker whose
  // profile holds two of the three, or whose dosimeter was swapped since it
  // was written down. Compared with the kit the form was filled from, so a
  // serial the Equipment tab assigns counts as on file. Waits for a pause in
  // the typing rather than the first keystroke, and is asked once a session
  // like the first offer, through the same mark.
  useEffect(() => {
    if (!equipReady || askDosimetry || dosimetryAskedFor(currentUser.id)) return undefined;
    const me = people.find(p => p.id === currentUser.id);
    if (!me || !newSerials(w1, kitOf(me, equipment)).length) return undefined;
    const t = setTimeout(() => {
      markDosimetryAsked(currentUser.id);
      setAskDosimetry("new");
    }, 1500);
    return () => clearTimeout(t);
  }, [w1, people, equipment, equipReady, askDosimetry, currentUser.id]);

  // What the button in that panel does. The serials it keeps are the ones on
  // the form — worker (1)'s boxes are the same three fields, so there is
  // nothing separate to type and nothing to fall out of step.
  const keepDosimetry = async () => {
    // Merged with what is already on file, never the typed kit alone:
    // set_own_dosimetry writes all three columns, so a box left empty here
    // would blank a serial the profile has. Job detail's close-out keeps the
    // same rule through the same helper.
    const me = people.find(p => p.id === currentUser.id);
    const serials = mergedSerials(w1, me ? kitOf(me, equipment) : {});
    if (!serials.tld && !serials.drd && !serials.alarm) return;
    setKeeping(true);
    setKeepMsg("");
    try {
      await Db.setOwnDosimetry(serials);
    } catch (e) {
      setKeeping(false);
      if (isMissingSetOwnDosimetry(e)) {
        // This database has not had the migration. Nothing is lost: what is
        // typed still files with this assessment; it just cannot be kept
        // from here yet, and saying who can is the useful half.
        setKeepable(false);
        setKeepMsg("This app can't put serials on a profile here yet. They'll go on this assessment as typed — ask an admin to add them to your profile so they're there next time.");
        return;
      }
      setKeepMsg((e.message || "Couldn't save them to your profile.") + " They'll still go on this assessment as typed.");
      return;
    }
    // The crew list is where the kit for the rest of this session is derived
    // from, so the copy this screen holds gets the new serials too. The
    // `currentUser` prop is App.jsx's and is left alone — nothing here reads
    // serials off it, and reaching into it from a screen would be a second
    // owner for the same fact.
    setPeople(prev => prev.map(p => p.id === currentUser.id
      ? { ...p, tld_serial: serials.tld || null, drd_serial: serials.drd || null, alarm_serial: serials.alarm || null }
      : p));
    setKeeping(false);
    setAskDosimetry("");
  };

  useEffect(() => {
    if (helperId !== w2For.current) { w2For.current = helperId; w2Touched.current = false; }
    if (w2Touched.current) return;
    const helper = people.find(p => p.id === helperId);
    setW2(helper ? kitOf(helper, equipment) : { unit: "", idCode: "", tld: "", drd: "", alarm: "" });
  }, [helperId, people, equipment]);

  // The exposure device is one shared piece of kit for the day, not per
  // worker like TLD/DRD/alarm — defaulted from whatever's assigned to
  // whoever is filing, same as the rest of their kit.
  useEffect(() => {
    const mine = equipment.find(e => e.type === "Exposure device" && e.assignedTo === currentUser.id);
    if (mine) setEquip(p => (p.redSerial ? p : { ...p, redSerial: mine.serial || "" }));
  }, [equipment, currentUser.id]);

  const toggle = i => setHazards(p => p.map((h, idx) => idx === i ? { ...h, on: !h.on } : h));
  const toggleExtra = i => setExtra(p => p.map((h, idx) => idx === i ? { ...h, on: !h.on } : h));
  const [addingExtra, setAddingExtra] = useState(false);
  const rate = (name, key, value) =>
    setRatings(p => ({ ...p, [name]: { ...(p[name] || {}), [key]: value } }));

  const commSelect = site.commOther ? "Other" : (COMM_PRESETS.includes(site.communication) ? site.communication : "");
  const selected = hazards.filter(h => h.on).concat(extra.filter(h => h.on));
  const onCount = selected.length;
  const helper = people.find(p => p.id === helperId);

  // Whether there is anything to keep yet. The offer's button waits on the
  // same condition filing does — one serial, whichever they're wearing.
  const w1HasSerial = !hasNoSerials(w1);

  // The four conditions submit() refuses on, counted as the form is filled
  // in rather than reported after the button is pressed. Kept in step with
  // the checks below — they are the same four, in the same order.
  const requiredLeft = [
    !onCount,
    !siteRep.trim() && !siteRepOther.trim(),
    !w1.tld.trim() && !w1.drd.trim() && !w1.alarm.trim(),
    !!helper && !w2.tld.trim() && !w2.drd.trim() && !w2.alarm.trim()
  ].filter(Boolean).length;

  const submit = async () => {
    if (!onCount) { setError("Tick at least one hazard before filing the JHA."); return; }
    if (!siteRep.trim() && !siteRepOther.trim()) {
      // Either box satisfies this, so both are flagged — highlighting one
      // would imply the other won't do.
      miss.flag("siteRep", "siteRepOther");
      setError("Record who this was reviewed with — the contractor rep, or someone else on site.");
      return;
    }
    const siteRepJoined = [siteRep.trim(), siteRepOther.trim()].filter(Boolean).join(" & ");
    if (!w1.tld.trim() && !w1.drd.trim() && !w1.alarm.trim()) {
      miss.flag("w1tld", "w1drd", "w1alarm");
      // Not "set them up in Users & access": a technician has no users tab,
      // so half that advice was a door they cannot open.
      setError("Nuclear energy worker (1) has no dosimetry recorded — fill in at least one serial, or ask an admin to add them to your profile.");
      return;
    }
    // The second worker is a nuclear energy worker too; a helper filed with
    // three blank serials is a dose record that names nobody's dosimeter.
    if (helper && !w2.tld.trim() && !w2.drd.trim() && !w2.alarm.trim()) {
      miss.flag("w2tld", "w2drd", "w2alarm");
      setError(`${helper.displayName} has no dosimetry recorded — fill in at least one serial for nuclear energy worker (2), or ask an admin to add them to that profile.`);
      return;
    }
    if (!job || !job.dbId) { setError("No job selected."); return; }
    miss.clear();
    setSaving(true);
    setError("");
    const dosimetry = [
      { slot: 1, profileId: currentUser.id, name: currentUser.name, ...w1, startReading: 0, endReading: null, doseMr: null }
    ];
    if (helper) {
      dosimetry.push({ slot: 2, profileId: helper.id, name: helper.displayName, ...w2, startReading: 0, endReading: null, doseMr: null });
    }
    const jhaPayload = {
      jobDbId: job.dbId, template: JHA_TEMPLATES[0],
      hazards: selected.map(h => ({ ...h, rating: ratings[h.name] || null })),
      signedBy: currentUser.id, siteRep: siteRepJoined,
      // Job numbers are free text; storage keys are not (# and ? truncate,
      // % breaks the request, non-ASCII is refused) — the same folding the
      // report upload applies, or the PDF silently never lands.
      pdfKey: `${storageKeySafe(job.id, "job")}-JHA-${Date.now()}.pdf`,
      dosimetry, unitNumber: w1.unit || null,
      workDate,
      details: { site, equipment: equip },
      clientKey
    };
    // The outbox is reached two ways — the radio dropped the answer, or the
    // device said up front there was no signal — and both file the same
    // payload the same way, so both come through here.
    const queueThisJha = async () => {
      try {
        await OfflineQueue.enqueue("jha", jhaPayload);
      } catch (queueErr) {
        // The outbox is IndexedDB, and it can refuse — private browsing, a
        // full disk, a wedged database. Unguarded, that threw straight out
        // of submit: the button stayed on "Filing…" for ever and nobody was
        // told. The recovery copy stays put, so the JHA is still here.
        setSaving(false);
        setError("No signal, and this device couldn't save it either — stay on this screen and try again once you're in range.");
        return;
      }
      // In the outbox now, which is a better home than the recovery copy.
      dropWip();
      setQueued(true);
    };

    // There is nothing to learn from asking a radio that is already off.
    // Waiting for the answer took about seven seconds — a token refresh and
    // then the request, each having to time out — with the form dimmed and
    // silent for all of it before arriving at this same outbox, which on a
    // job site reads as a hung app and gets the button pressed again.
    if (deviceOffline()) { await queueThisJha(); return; }

    try {
      await Db.createJha(jhaPayload);
      dropWip();
      onSubmitted();
    } catch (e) {
      // A refusal the server gave is a reason whatever the radio says —
      // the order oqFlushOnce and the ticket editor keep.
      if (!e.plain && OfflineQueue.isNetworkError(e)) {
        await queueThisJha();
        return;
      }
      setSaving(false);
      setError(e.message || "Couldn't file the JHA — try again.");
    }
  };

  if (queued) return <QueuedPanel what="this hazard assessment" onDone={onSubmitted} />;
  if (!job) return <NoJobSelected what="a hazard assessment" />;

  return (
    // Room at the foot of the page for the fixed bar below — two rows of it
    // once the count and the button stop sharing a line on a phone, plus the
    // home indicator on an iPhone. Without it Cancel sits under the bar and
    // cannot be reached.
    <div className="page" style={{ paddingBottom: "calc(150px + env(safe-area-inset-bottom, 0px))" }}>
      <div className="phone-shell">
        <Blueprint className="phone-frame">
          <ConnectionBar label={job.id} />
          <div>
            <div className="kicker">{job.id} · Hazard assessment</div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 22 }}>{job.project}</div>
            <div className="tabular" style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{job.lsd} · {job.client}</div>
          </div>

          {recovered && (
            <div style={{
              fontSize: 12, padding: "8px 10px",
              border: "1px solid var(--color-accent-700)",
              background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap"
            }}>
              <span>Brought back the assessment you were building{recovered ? ` at ${new Date(recovered).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" })}` : ""} — it was never filed.</span>
              <button type="button" onClick={discardRecovered}
                style={{ marginLeft: "auto", background: "none", border: "none", textDecoration: "underline", cursor: "pointer", color: "inherit", font: "inherit", padding: 0 }}>
                Start empty
              </button>
            </div>
          )}

          <JhaSection title="Site information" />
          {prefilledFrom && (
            <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginTop: -2 }}>
              Site details and kit switches carried over from this job's last assessment{prefilledFrom !== true ? ` (${dayMonth(localDate(prefilledFrom))})` : ""} — check they still hold today. Weather, survey and bump test start fresh.
            </div>
          )}
          <Field label="Date of this assessment">
            {/* Capped at today: an assessment can be written up after the
                fact, never in advance of the work it covers. */}
            <input className="input" type="date" value={workDate} max={todayLocal()}
              onChange={e => setWorkDate(e.target.value || todayLocal())} />
          </Field>
          {backdated && (
            <div style={{ border: "1px solid var(--color-accent)", padding: "10px 12px", fontSize: 12 }}>
              Being written up for {dayMonth(localDate(workDate))}, not today. The assessment and its PDF will carry that date; the record will still show it was filed today by {currentUser.name}.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="Weather">
              <select className="input" value={site.weather} onChange={e => setSite(p => ({ ...p, weather: e.target.value }))}>
                <option value="">Select…</option>
                {["Clear", "Cloudy", "Windy", "Foggy", "Raining", "Snowing"].map(w => <option key={w}>{w}</option>)}
              </select>
            </Field>
            <Field label="Temperature">
              <select className="input" value={site.temperature} onChange={e => setSite(p => ({ ...p, temperature: e.target.value }))}>
                <option value="">Select…</option>
                {["Hot", "Warm", "Cool", "Cold", "Freezing"].map(t => <option key={t}>{t}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Communication">
            <select className="input" value={commSelect}
              onChange={e => setSite(p => ({ ...p, communication: e.target.value === "Other" ? "" : e.target.value, commOther: e.target.value === "Other" }))}>
              <option value="">Select…</option>
              {COMM_PRESETS.map(c => <option key={c}>{c}</option>)}
              <option value="Other">Other</option>
            </select>
            {commSelect === "Other" && (
              <input className="input" style={{ marginTop: 8 }} value={site.communication} placeholder="Describe how the crew stays in contact"
                onChange={e => setSite(p => ({ ...p, communication: e.target.value }))} autoFocus />
            )}
          </Field>
          <Field label="Muster point"><input className="input" value={site.muster} onChange={e => setSite(p => ({ ...p, muster: e.target.value }))} /></Field>
          <Field label="First aid attendant on site">
            <select className="input" value={site.firstAid} onChange={e => setSite(p => ({ ...p, firstAid: e.target.value }))}>
              <option value="">Select…</option>
              <option>Yes</option>
              <option>No</option>
            </select>
          </Field>
          <Field label="Nearest hospital"><input className="input" value={site.hospital} onChange={e => setSite(p => ({ ...p, hospital: e.target.value }))} /></Field>

          <JhaSection title="Hazards" note={`${onCount} of ${hazards.length + extra.length} selected`} />
          {/* The list is the one part of this form with no box to mark, and
              filing refuses without a tick — so the rule is said here rather
              than discovered at the bottom of the screen. Stated, not
              flagged: nothing is ticked when the screen opens, and a red
              line on arrival would be an accusation before anyone has done
              anything. */}
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: -2 }}>
            At least one hazard has to be ticked.
          </div>
          {Object.keys(remembered).length > 0 && (
            <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: -2 }}>
              Sev, Prob and Freq start from what you rated each hazard last time. Change any that are different today.
            </div>
          )}
          {/* Scrolls inside its box on a desk, where the page is a mockup
              frame; on a phone the page itself scrolls (app.css), so the
              list and the page don't fight over every swipe. */}
          <div className="hazard-list" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {hazards.map((h, i) => (
              <HazardRow key={h.name} hazard={h} rating={ratings[h.name]} onToggle={() => toggle(i)}
                onRate={(k, v) => rate(h.name, k, v)} />
            ))}
            {extra.map((h, i) => (
              <HazardRow key={"extra" + i} hazard={h} rating={ratings[h.name]} onToggle={() => toggleExtra(i)}
                onRate={(k, v) => rate(h.name, k, v)} />
            ))}
          </div>
          <Btn variant="secondary" block style={{ minHeight: 52, borderStyle: "dashed" }} onClick={() => setAddingExtra(true)}>+ Add site-specific hazard</Btn>
          {addingExtra && (
            <AddHazardDialog onClose={() => setAddingExtra(false)}
              onAdd={h => { setExtra(p => [...p, h]); setAddingExtra(false); }} />
          )}

          <JhaSection title="Equipment record" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {PPE_CHECKS.map(p => (
              <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <CheckBox on={!!equip.ppe[p.key]} size={22} label={p.label}
                  onChange={() => setEquip(e => ({ ...e, ppe: { ...e.ppe, [p.key]: !e.ppe[p.key] } }))} />
                <span style={{ fontSize: 13 }}>{p.label}</span>
              </div>
            ))}
          </div>
          <Field label="H₂S gas monitor serial"><input className="input" value={equip.h2sSerial} onChange={e => setEquip(p => ({ ...p, h2sSerial: e.target.value }))} /></Field>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch on={equip.h2sBumpTest} label="Bump test performed" onClick={() => setEquip(p => ({ ...p, h2sBumpTest: !p.h2sBumpTest }))} />
            <span style={{ fontSize: 13 }}>Bump test performed</span>
          </div>
          <Field label="Exposure device (R.E.D.) serial"><input className="input" value={equip.redSerial} placeholder="Delta 880" onChange={e => setEquip(p => ({ ...p, redSerial: e.target.value }))} /></Field>
          <Field label="Device surface survey (mR/h)">
            {/* A keystroke that would leave something other than a reading is
                refused outright rather than filtered — "1e6" used to land as 16. */}
            <input className="input" type="text" inputMode="decimal" value={equip.redSurveyMr}
              onChange={e => { const v = e.target.value; if (acceptsNumberText(v, 0.1)) setEquip(p => ({ ...p, redSurveyMr: v })); }} />
          </Field>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch on={equip.collimator} label="Collimator available" onClick={() => setEquip(p => ({ ...p, collimator: !p.collimator }))} />
            <span style={{ fontSize: 13 }}>Collimator available</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch on={equip.emergencyKit} label="Emergency equipment on hand" onClick={() => setEquip(p => ({ ...p, emergencyKit: !p.emergencyKit }))} />
            <span style={{ fontSize: 13 }}>Shield tunnel, tongs &amp; cutters on hand</span>
          </div>

          <JhaSection title="Nuclear energy worker (1)" note="Technician" />
          <div style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>{currentUser.name}</div>
          {/* Inline, above the boxes it is talking about, and never a dialog:
              this is an offer, and a modal in front of a form somebody is
              filling in on a lease is an interruption. The three fields are
              worker (1)'s own — there is nothing extra to type here. */}
          {askDosimetry && (
            <div style={{
              fontSize: 12, padding: "8px 10px",
              border: "1px solid var(--color-accent-700)",
              background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
              display: "flex", flexDirection: "column", gap: 8
            }}>
              <span>
                {askDosimetry === "new"
                  ? "A serial below isn't on your profile. Keep it there and the app fills it in next time."
                  : "No dosimeter serials are on your profile yet. Enter your TLD, DRD and alarm serials once and the app will keep them for next time."}
              </span>
              {keepMsg && <span style={{ color: "var(--color-accent-700)" }}>{keepMsg}</span>}
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {keepable && (
                  <Btn variant="secondary" onClick={keepDosimetry} disabled={keeping || !w1HasSerial}>
                    {keeping ? "Keeping…" : "Keep these on my profile"}
                  </Btn>
                )}
                <button type="button" onClick={() => setAskDosimetry("")}
                  style={{ background: "none", border: "none", textDecoration: "underline", cursor: "pointer", color: "inherit", font: "inherit", padding: 0 }}>
                  {keepable ? "Not now" : "Close"}
                </button>
                {keepable && !w1HasSerial && (
                  <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                    Fill in at least one serial below first.
                  </span>
                )}
              </div>
            </div>
          )}
          <WorkerKit value={w1} onChange={editW1} missing={miss.is} onFixed={miss.clear} />

          <JhaSection title="Nuclear energy worker (2)" note="Helper — if one is on site" />
          <Field label="Worker">
            <select className="input" value={helperId} onChange={e => setHelperId(e.target.value)}>
              <option value="">Working alone today</option>
              {people.filter(p => p.id !== currentUser.id).map(p => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
          </Field>
          {helper && <WorkerKit value={w2} onChange={editW2} prefix="w2" missing={miss.is} onFixed={miss.clear} />}

          <JhaSection title="Review" />
          <Field label="Site rep name" required missing={miss.is("siteRep")}>
            <input {...miss.props("siteRep")} value={siteRep} placeholder="Contractor rep"
              onChange={e => { miss.clear(); setSiteRep(e.target.value); }} />
          </Field>
          <Field label="Add another site rep" missing={miss.is("siteRepOther")}>
            <input {...miss.props("siteRepOther")} value={siteRepOther} placeholder="Anyone else reviewing this on site"
              onChange={e => { miss.clear(); setSiteRepOther(e.target.value); }} />
          </Field>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            Filed by {currentUser.name} — the account filing is the record, so no signature is collected.
            End readings are entered when the day is closed out.
          </div>

          <ErrorBox>{error}</ErrorBox>
          {/* File JHA and the count of what is still outstanding are not here
              any more — they are in the bar pinned to the foot of the screen,
              below, because this form is several phone-screens of hazards
              deep and the button that finishes it sat under all of them.
              Cancel stays: throwing the assessment away is the rare act, and
              it belongs at the end of the form rather than under a thumb on
              every screenful. */}
          <Btn variant="ghost" block style={{ minHeight: 44, marginTop: 8 }} disabled={saving}
            onClick={() => { if (confirm("Discard this hazard assessment? Nothing has been filed yet.")) { dropWip(); onCancel(); } }}>
            Cancel
          </Btn>
        </Blueprint>

        <div className="phone-explain">
          <p>The FLHA as the crew fills it: site information, the hazard worksheet with a severity, probability and frequency rating each, the equipment record, and both nuclear energy workers with their dosimetry.</p>
          <p>Unit #, ID code and the three serials come from each person's profile in Users &amp; access — change one here only if equipment was swapped that day.</p>
          <p>Start readings are always 0, so the end reading is the dose. Those are entered at the end of the day: the assessment stays <strong>Open</strong> on Job detail until it's closed out.</p>
        </div>
      </div>

      {/* What the form is still waiting on, and the way out of it, on the
          glass however far down the hazard list someone has scrolled. The
          count is the same one submit() refuses on, so the bar goes quiet at
          the moment filing will actually work. */}
      <div className="screen-foot">
        {/* Announced as it changes, the way the line above the button used
            to be: a screen reader hears the last serial being typed take the
            count to nothing. */}
        <div aria-live="polite" style={{ flex: "1 1 auto", minWidth: 0, fontSize: 13 }}>
          {requiredLeft
            ? <span style={{ color: "var(--color-accent-700)" }}>{requiredLeft} required left</span>
            : <span style={{ color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>Ready to file</span>}
        </div>
        <div style={{ display: "flex", flex: "1 1 180px", justifyContent: "flex-end" }}>
          <Btn variant="primary" style={{ minHeight: 48, fontSize: 15 }} onClick={submit} disabled={saving}>{saving ? savingLabel(savingMs, "Filing…") : "File JHA"}</Btn>
        </div>
      </div>
    </div>
  );
}

// Pull a person's assigned kit off their profile, then let anything they're
// actually assigned on the Equipment tab override the DRD and alarming
// dosimeter serials — those get swapped between people more often than the
// profile record gets updated to match.
function kitOf(p, equipment) {
  const list = equipment || [];
  const tldItem = list.find(e => e.type === "TLD / OSLD" && e.assignedTo === p.id);
  const drdItem = list.find(e => e.type === "Dosimeter" && e.assignedTo === p.id);
  const alarmItem = list.find(e => e.type === "Survey meter" && e.assignedTo === p.id);
  return {
    unit: p.unit_number || "", idCode: p.id_code || "",
    tld: (tldItem && tldItem.serial) || p.tld_serial || "",
    drd: (drdItem && drdItem.serial) || p.drd_serial || "",
    alarm: (alarmItem && alarmItem.serial) || p.alarm_serial || ""
  };
}

// A native prompt() is a no-op in some embedded preview hosts (returns
// immediately, no dialog shown) — an in-app dialog works everywhere and
// matches every other add-something flow in this app.
function AddHazardDialog({ onClose, onAdd }) {
  const [name, setName] = useState("");
  const [control, setControl] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), control: control.trim() || "Add control measure", level: "Med", on: true });
  };
  return (
    <Dialog title="Site-specific hazard" onClose={onClose}
      actions={<><Btn variant="secondary" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={submit} disabled={!name.trim()}>Add</Btn></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Hazard name">
          <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Wildlife on lease" />
        </Field>
        <Field label="Recommended action / control measure">
          <textarea className="input" value={control} onChange={e => setControl(e.target.value)} placeholder="e.g. Bear spray, no lone work at dusk" />
        </Field>
      </div>
    </Dialog>
  );
}

function JhaSection({ title, note }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--color-divider)" }}>
      <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)" }}>{title}</span>
      {note && <span style={{ marginLeft: "auto", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{note}</span>}
    </div>
  );
}

// Unit, ID code and the three pieces of monitoring equipment. Pre-filled from
// the profile; editable here because equipment does get swapped.
// `missing` is optional — filing needs at least one of a worker's three
// serials, so all three light up together rather than singling one out.
// `prefix` keys the flags per worker ("w1tld" / "w2tld"), so worker (2)'s
// blanks don't light worker (1)'s boxes.
function WorkerKit({ value, onChange, missing, onFixed, prefix = "w1" }) {
  const set = (k, v) => { if (onFixed) onFixed(); onChange({ ...value, [k]: v }); };
  const dos = k => ({
    className: missing && missing(prefix + k) ? "input invalid" : "input",
    "aria-invalid": (missing && missing(prefix + k)) || undefined
  });
  const bad = k => !!(missing && missing(prefix + k));
  // All three light together when filing found none of them filled in.
  const anyBad = bad("tld") || bad("drd") || bad("alarm");
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="Unit #"><input className="input" value={value.unit} onChange={e => set("unit", e.target.value)} /></Field>
        <Field label="ID code"><input className="input" value={value.idCode} onChange={e => set("idCode", e.target.value)} /></Field>
      </div>
      {/* Said once over the group rather than "required" on each of the
          three, which would claim all three are needed. Filing wants one.
          Both workers get the line: the helper's kit is checked the same
          way the moment one is picked. */}
      <div style={{ fontSize: 11, color: anyBad ? "var(--color-accent-700)" : "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
        At least one of these three serials is required — whichever dosimetry they're wearing.
      </div>
      <Field label="TLD / OSLD" missing={bad("tld")}>
        <input {...dos("tld")} value={value.tld} onChange={e => set("tld", e.target.value)} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="DRD" missing={bad("drd")}>
          <input {...dos("drd")} value={value.drd} onChange={e => set("drd", e.target.value)} />
        </Field>
        <Field label="Alarming dosimeter" missing={bad("alarm")}>
          <input {...dos("alarm")} value={value.alarm} onChange={e => set("alarm", e.target.value)} />
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "end" }}>
        <Field label="Start reading (mR)"><input className="input" value="0" disabled /></Field>
        <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", paddingBottom: 10 }}>
          End reading at close-out
        </div>
      </div>
    </>
  );
}

function HazardRow({ hazard, rating, onToggle, onRate }) {
  const r = rating || {};
  const pri = priorityOf(r);
  return (
    // The rating strip sits outside .hazard-row rather than wrapping inside it:
    // that row is a fixed-height flex line, and a wrapped second line overflowed
    // it and collided with the hazard underneath.
    <div style={{ border: hazard.on ? "1px solid var(--color-accent)" : "1px solid transparent", background: hazard.on ? "color-mix(in srgb, var(--color-accent) 7%, transparent)" : "transparent" }}>
      <div className="hazard-row" style={{ border: 0, background: "transparent" }}>
        {/* 40px, like the rating buttons: the one thing this screen exists to
            record is ticked with gloves on. */}
        <CheckBox on={hazard.on} onChange={onToggle} label={hazard.name} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15 }}>{hazard.name}</div>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{hazard.control}</div>
        </div>
        <TagX variant={hazardTagVariant(hazard.level)}>{hazard.level}</TagX>
      </div>
      {/* Rated only once it's on the sheet — three taps, not three text fields.
          The boxes are 40px, not the 28 they were: this is tapped on a phone,
          often with a glove on, and 28 is under every touch-target guideline
          going. Nine boxes that size cannot share one line at 390px, so each
          Sev/Prob/Freq set wraps as a whole — flex:none on the sets and on
          the boxes, or the row squeezes them into slivers instead. The gaps
          are 2px rather than 4: it buys the few pixels that fit two sets on
          a line, which is two lines per hazard instead of three. */}
      {hazard.on && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "0 10px 10px" }}>
          {[["s", "Sev"], ["p", "Prob"], ["f", "Freq"]].map(([key, label]) => (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 2, flex: "0 0 auto" }}>
              <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em", color: "color-mix(in srgb, var(--color-text) 55%, transparent)", width: 30, flex: "none" }}>{label}</span>
              {RATING_SCALE.map(n => (
                <button key={n} type="button" onClick={() => onRate(key, n)}
                  aria-label={`${label} ${n} for ${hazard.name}`}
                  aria-pressed={r[key] === n}
                  style={{
                    width: 40, height: 40, flex: "none", cursor: "pointer", fontSize: 12,
                    fontFamily: "var(--font-heading)", fontWeight: 600,
                    border: "1px solid " + (r[key] === n ? "var(--color-accent)" : "var(--color-divider)"),
                    background: r[key] === n ? "var(--color-accent)" : "transparent",
                    color: r[key] === n ? "var(--color-bg)" : "var(--color-text)"
                  }}>{n}</button>
              ))}
            </div>
          ))}
          {pri.total > 0 && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-accent)", whiteSpace: "nowrap" }}>
              Priority {pri.total} · {pri.band}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
