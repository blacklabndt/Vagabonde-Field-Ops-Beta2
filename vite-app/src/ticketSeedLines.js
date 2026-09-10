// Lines a draft from Ask asks for, matched to the client's rate card by
// label — case-insensitive, against the card's own label or the plain
// words before its " · " / " — " suffix (the RT modes and the per-weld
// methods dress their label up that way). What matches becomes form lines
// with their quantities; what does not is named, never invented.
export function seedLinesToForm(lines, catalog) {
  const welds = [];
  const others = [];
  const unmatched = [];
  const plain = s => String(s || "").toLowerCase().split(/ · | — /)[0].trim();
  const find = (list, label) => {
    const want = String(label).toLowerCase().trim();
    return list.find(x => String(x.label).toLowerCase() === want)
      || list.find(x => plain(x.label) === want)
      || list.find(x => plain(x.label) === plain(label));
  };
  for (const l of lines || []) {
    const qty = Number(l && l.quantity);
    if (!l || !l.label || !Number.isFinite(qty) || qty <= 0) continue;
    const w = find((catalog && catalog.welds) || [], l.label);
    if (w) { welds.push({ key: w.key, qty }); continue; }
    const o = find((catalog && catalog.others) || [], l.label);
    if (o) { others.push({ key: o.key, qty }); continue; }
    unmatched.push(l.label);
  }
  return { welds, others, unmatched };
}
