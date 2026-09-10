// Catches names that exist at build time but not at render time.
//
//   node scripts/check-render.cjs src
//
// Vite compiles JSX to `jsx(Foo, …)` without caring whether `Foo` resolves,
// and a hook is just a function call. Both build clean and both throw the
// moment the branch renders — so the failure surfaces as a blank screen in
// the field, not as a red line in the build log. This has bitten twice:
// `useRef is not defined` shipped to the rate admin screen, and the same
// mistake was caught here in the ticket screen a day later.
//
// Deliberately a regex pass, not a parser: it has to stay dependency-free so
// it can run anywhere `node` runs, and the failure mode it guards is coarse
// enough that a rough scan catches it.

const fs = require("node:fs");
const path = require("node:path");

// Every hook React exports, not only the ones the app happens to use today:
// the whole point of the scan is to catch the one that gets reached for next
// and typed without its import, and a hook missing from this list is a hook
// the scan silently approves.
const HOOKS = [
  "useState", "useEffect", "useRef", "useCallback",
  "useMemo", "useReducer", "useContext", "useLayoutEffect",
  "useId", "useSyncExternalStore", "useTransition", "useDeferredValue",
  "useImperativeHandle", "useInsertionEffect", "useDebugValue",
];

// Tags that are components to JSX but never imports.
const BUILTIN_TAGS = new Set(["React", "Fragment"]);

const root = process.argv[2] || "src";

// The text inside every parameter list in a file: a `function`'s, and an
// arrow's. Parentheses are matched by counting rather than by a regex,
// because a parameter's default value brings its own brackets along
// (`({ fmt = money(0), rows = [] })`) and a non-greedy match would cut the
// list off at the first one.
function parameterLists(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "(") continue;
    const afterFunction = /\bfunction\s*[\w$]*\s*$/.test(src.slice(Math.max(0, i - 60), i));
    let depth = 0, j = i;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    if (j >= src.length) continue;
    if (afterFunction || /^\s*=>/.test(src.slice(j + 1, j + 6))) out.push(src.slice(i + 1, j));
  }
  return out;
}

const walk = d => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

const problems = [];
const report = (file, msg) =>
  problems.push(`${path.relative(root, file).replace(/\\/g, "/")}: ${msg}`);

for (const file of walk(root).filter(f => /\.(jsx?|mjs)$/.test(f))) {
  const src = fs.readFileSync(file, "utf8");

  // ── what this file imports from react ──
  const reactImport = /import\s+(?:React,\s*)?(?:\{([^}]*)\})?\s*from\s*["']react["']/.exec(src);
  const fromReact = reactImport && reactImport[1]
    ? reactImport[1].split(",").map(s => s.trim().split(/\s+as\s+/).pop().trim())
    : [];

  // ── hooks called bare but never imported ──
  const withoutImportLine = reactImport ? src.replace(reactImport[0], "") : src;
  for (const hook of HOOKS) {
    // A bare call: not React.useX, not part of a longer identifier.
    const called = new RegExp(`(^|[^.\\w])${hook}\\s*\\(`, "m").test(withoutImportLine);
    if (called && !fromReact.includes(hook)) {
      report(file, `${hook}() is called but not imported from react`);
    }
  }

  if (!file.endsWith(".jsx")) continue;

  // ── capitalised JSX tags with nothing behind them ──
  const known = new Set(BUILTIN_TAGS);

  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = m[1];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      braces[1].split(",")
        .map(s => s.trim().split(/\s+as\s+/).pop())
        .filter(Boolean)
        .forEach(n => { known.add(n); });
    }
    const dflt = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
    if (dflt) known.add(dflt.replace(/^\*\s+as\s+/, ""));
  }

  // Declared here: function Foo, const/let/var/class Foo.
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Z]\w*)/g)) known.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var|class)\s+([A-Z]\w*)/g)) known.add(m[1]);

  // Bound by the component itself rather than declared at module scope:
  //   ({ as: Tag = "div" })  — a polymorphic wrapper picking its own element
  //   ({ icon: Icon })       — a component passed in as a prop
  //   const { Thing } = …    — destructured from anything
  //
  // The rename half is read out of parameter lists only. `key: Value` looks
  // the same in an ordinary object — `const style = { border: Accent }` — and
  // approving those meant any capitalised word that appeared once as some
  // object's value silently vouched for a <Tag> of the same name that was
  // never imported. That is precisely the blank screen this scan exists for.
  for (const params of parameterLists(src)) {
    for (const m of params.matchAll(/\b[\w$]+\s*:\s*([A-Z]\w*)\s*(?:=[^,}]*)?\s*[,}]/g)) known.add(m[1]);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    m[1].split(",").map(s => s.trim().split(":").pop().trim().split("=")[0].trim())
      .filter(n => /^[A-Z]\w*$/.test(n)).forEach(n => { known.add(n); });
  }
  // Plain function parameters: function Foo(Bar) / (Bar) =>
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
    m[1].split(",").map(s => s.trim().split("=")[0].trim())
      .filter(n => /^[A-Z]\w*$/.test(n)).forEach(n => { known.add(n); });
  }

  const used = new Set();
  // The dots are part of the name, or the check below them is dead: `\w` stops
  // at the dot, so `<Motion.div>` was read as `<Motion` — which never matched
  // the `[\s/>]` that has to follow, so the tag was not collected at all and
  // the namespaced branch under this loop had never once run.
  for (const m of src.matchAll(/<([A-Z][\w$]*(?:\.[\w$]+)*)[\s/>]/g)) used.add(m[1]);

  for (const tag of used) {
    // <Foo.Bar> resolves through Foo.
    const base = tag.split(".")[0];
    if (!known.has(tag) && !known.has(base)) {
      report(file, `<${tag}> is used but is not imported or defined`);
    }
  }
}

// A hook below an early return. It builds, it renders on the branch that
// returns early, and it throws "Rendered more hooks than during the previous
// render" on the other — the ticket screen shipped that way once, and the
// lapsed-session sign-out captured a function declared below the shell's
// returns a second time. Read per top-level component: the first
// `  if (…) return` at two-space indent marks the returns, and any hook
// call after it in the same function is reported.
// Any `useSomething(` at one indent. A named list approved the hook nobody
// had added to it yet — React's own useTransition and useSyncExternalStore
// were never in it, and neither is the next custom hook anyone writes.
const HOOK_CALL = /^  (?:const |let )?.*\buse[A-Z]\w*\s*\(/;
for (const file of walk(root).filter(f => /\.jsx$/.test(f))) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let fn = null, firstReturn = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // A component is not always a bare `function Foo(`: memo and forwardRef
    // wrap one, and ChatRow and Blueprint are both declared that way.
    const m = l.match(/^(?:export )?function ([A-Z]\w*)\(/)
      || l.match(/^(?:export )?const [A-Z]\w* = (?:React\.)?(?:memo|forwardRef)\(function ([A-Z]\w*)\(/);
    if (m) { fn = m[1]; firstReturn = null; continue; }
    if (!fn) continue;
    if (/^}/.test(l)) { fn = null; continue; }
    // Both shapes of early return: the whole thing on one line, and a brace
    // opened here whose `return` is on the next line. App's own
    // `if (checkingSession) {` is the second, and it was invisible.
    if (firstReturn === null && /^  if \(.*\) (?:return\b|\{[^}]*\breturn\b)/.test(l)) firstReturn = i + 1;
    // The brace form: a `return` anywhere inside the block, not only on the
    // very next line — ContactCard puts four comment lines between the two.
    if (firstReturn === null && /^  if \(.*\) \{\s*$/.test(l)) {
      for (let j = i + 1; j < lines.length && !/^  \}/.test(lines[j]); j++) {
        if (/^    return\b/.test(lines[j])) { firstReturn = i + 1; break; }
      }
    }
    if (firstReturn !== null && HOOK_CALL.test(l)) {
      report(file, `line ${i + 1}: a hook in ${fn} sits below the early return at line ${firstReturn}`);
    }
  }
}

if (problems.length) {
  for (const p of problems) console.log(p);
  console.log(`\n${problems.length} problem(s) — these build fine and crash on render.`);
  process.exit(1);
}
console.log("check-render: every hook and component resolves");
