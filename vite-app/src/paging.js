// Reading past PostgREST's silent response cap.
//
// Two shapes, and which one a read gets is a judgement about what a wrong
// answer costs. Both live here rather than in db.js so the rules can be
// tested without a database — the failure they guard is a row that isn't
// there, which no screen can show you.

// PostgREST will not return more than 1000 rows in a single response, no
// matter what limit is asked for — and it does not say so. A request for
// 100000 rows comes back with 1000 and looks complete.
//
// That is fine for anything paged, and quietly wrong for anything that means
// "all of them": the accounting export was writing a CSV of the first 1000
// tickets, and a pay period with more than 1000 crew rows would have dropped
// hours off a timesheet. Both now page until the source is exhausted.
export const RESPONSE_ROW_CAP = 1000;

// Run `fn` over `items` at most `n` at a time, answering in the input's
// order whatever order the answers came back in. One at a time left a
// truck's connection waiting on the network with nothing else happening;
// four at once is enough to stop that and few enough not to drown it.
// `fn` is expected to answer rather than throw where the caller wants
// every item's result (the archive wraps its own failures); a throw ends
// the whole run with that error.
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

// Fetch every page of something that exceeds the 1000-row response cap.
//
// The two callers used to walk pages one at a time, each waiting on the last.
// That is the only safe shape when you don't know how many pages there are,
// but it costs a full round trip per 1000 rows: exporting 50,000 tickets was
// 51 sequential requests and about fourteen seconds.
//
// Page 0 comes back with the total, which is all that's needed to know how
// many pages exist and ask for them at once. Six at a time rather than all of
// them — a phone on a lease does not benefit from fifty concurrent requests,
// and PostgREST is happier too. Pages are reassembled in order, which matters:
// the underlying queries have a total order and the CSV inherits it.
//
// What it cannot do is survive a row leaving the source mid-walk. Every page
// is an OFFSET, so a delete between page 0 and page 3 shifts every later row
// up by one and the row that slid across the boundary is never asked for.
// Ordering by id does not help — offsets count rows, not keys. That is an
// acceptable trade for the reference lists (a dropped contractor reappears on
// the next load); it is not acceptable for anything people are paid or billed
// from, and those use fetchAllKeyset below.
//
// `fetchPage(page, pageSize)` gets the block to read and how many rows a block
// holds, and asks for rows `page * pageSize` onwards. The size is handed over
// rather than taken from the constant for the same reason the keyset walk
// learns it: RESPONSE_ROW_CAP is what a page asks for, and the API's max-rows
// setting is what it gets. Lower that setting and page 0 comes back short —
// pages built on the constant would then read rows 0-249, 1000-1249,
// 2000-2249, with the rows in between never asked for at all. So page 0 asks
// for the cap and teaches the walk what a block really is; every later page
// is offset by that.
const PAGE_CONCURRENCY = 6;
export async function fetchAllPages(fetchPage) {
  const first = await fetchPage(0, RESPONSE_ROW_CAP);
  const rows = first.rows.slice();
  // A page 0 that came back without a usable total has said nothing about
  // what follows it, and the arithmetic below turns that into `new Array(NaN)`
  // — a RangeError thrown out of a read that was only ever asked for a list.
  // Every caller here passes `count ?? rows.length`, so the count is the
  // server's or the page's own length; anything else is a source that never
  // counted, and page 0 is all it is offering.
  const total = Number(first.total);
  if (!first.rows.length || !Number.isFinite(total) || rows.length >= total) return rows;

  // What page 0 actually returned is the block size, whatever was asked for.
  // It is never zero here (the empty case returned above) and never more than
  // the cap, so the arithmetic below is safe either way.
  const pageSize = Math.min(first.rows.length, RESPONSE_ROW_CAP);
  const pageCount = Math.ceil(total / pageSize);
  const pages = new Array(pageCount);
  pages[0] = first.rows;

  for (let start = 1; start < pageCount; start += PAGE_CONCURRENCY) {
    const batch = [];
    for (let p = start; p < Math.min(start + PAGE_CONCURRENCY, pageCount); p++) {
      batch.push(fetchPage(p, pageSize).then(r => { pages[p] = r.rows; }));
    }
    await Promise.all(batch);
  }
  // Rows added between page 0 and the last page would land beyond `total`;
  // flat() keeps whatever actually arrived rather than trusting the estimate.
  return pages.flat();
}

// The same "all of them", asked for by key instead of by offset.
//
// Each page says "the next thousand rows after this id" rather than "rows
// 3000 to 3999", so a row deleted while the walk is in flight moves nothing:
// the keys that remain are still greater than the last one seen. It costs the
// concurrency — page N+1 can't be asked for until page N has come back — and
// that is the right price for a timesheet or an accounting export, where a
// silently missing row is somebody's hours or somebody's invoice.
//
// `fetchAfter(lastKey)` gets null on the first call and the last row's key
// after that, and returns the rows. A short page ends the walk — short
// against what the source is actually sending, not against the constant:
// RESPONSE_ROW_CAP is what each page asks for, and the API's max-rows
// setting is what it gets. Lower that setting and every page comes back at
// the new ceiling, which "fewer than 1000 means that was the last of them"
// reads as the end of the walk — a timesheet or an export cut off at the cap
// with nothing on screen to say so.
//
// So the first page teaches the walk what a full page holds — which means the
// first page is never short against itself, and any walk that fits in one
// page pays a second, empty round trip to learn it has ended. That is most
// walks, not only the ones that land exactly on a boundary: one extra request
// for a timesheet or an export, and the cheaper of the two mistakes by a long
// way.
export async function fetchAllKeyset(fetchAfter, keyOf = row => row.id) {
  const all = [];
  let after = null;
  let pageSize = null;
  for (;;) {
    const rows = await fetchAfter(after);
    if (!rows || !rows.length) return all;
    for (const r of rows) all.push(r);
    if (pageSize == null) pageSize = rows.length;
    if (rows.length < pageSize) return all;
    const next = keyOf(rows[rows.length - 1]);
    // A full page whose last key is the one we already asked past would ask
    // for the same thousand rows for ever. Stopping with what we have is the
    // only answer that terminates; it can only happen if the ordering and the
    // key disagree, which is a bug in the caller, not a state to spin on.
    if (next == null || next === after) return all;
    after = next;
  }
}
