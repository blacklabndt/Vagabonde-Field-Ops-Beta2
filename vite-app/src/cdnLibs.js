// The two heavy libraries the app fetches on demand — SheetJS for
// spreadsheets, jsPDF with its table plugin for PDFs — loaded from the CDN
// the CSP allows (worker/csp.mjs; workerCsp.test.mjs reads this file back),
// with SRI so a tampered response fails to run inside the signed-in app.
// Timesheets' exports and approvals and Ask's files share these; they lived
// in timesheets.jsx until Ask needed them too.

// One place makes the CDN <script> tags. The versions are pinned, so the
// bytes can be pinned too: `integrity` makes a tampered CDN response fail
// to execute instead of running inside the signed-in app. The timeout is
// for the request that neither loads nor errors — without it a stalled
// fetch left "Exporting…" or an approval spinning forever, with the cached
// promise poisoned so even a retry click did nothing.
function cdnScript(src, integrity, onDone, onFail) {
  const tag = document.createElement("script");
  tag.src = src;
  tag.integrity = integrity;
  tag.crossOrigin = "anonymous";
  const timer = setTimeout(() => { tag.remove(); onFail(); }, 30000);
  tag.onload = () => { clearTimeout(timer); onDone(); };
  tag.onerror = () => { clearTimeout(timer); onFail(); };
  document.head.appendChild(tag);
}

// SheetJS is ~900 KB and only a few buttons need it, so it's fetched on the
// first export rather than blocking every page load.
let xlsxPromise = null;
export function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxPromise) {
    xlsxPromise = new Promise((resolve, reject) => {
      cdnScript(
        "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
        "sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw",
        () => resolve(window.XLSX),
        () => { xlsxPromise = null; reject(new Error("Couldn't load the spreadsheet library.")); }
      );
    });
  }
  return xlsxPromise;
}

// jsPDF and its table plugin, from the CDN on first use — the same bargain
// as SheetJS above, with the same recovery: a failed load clears the
// promise so the next click retries instead of staying poisoned.
let jspdfPromise = null;
export function loadJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable) {
    return Promise.resolve(window.jspdf.jsPDF);
  }
  if (!jspdfPromise) {
    jspdfPromise = new Promise((resolve, reject) => {
      const fail = () => { jspdfPromise = null; reject(new Error("Couldn't load the PDF builder — check the connection and try again.")); };
      cdnScript(
        "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js",
        "sha384-en/ztfPSRkGfME4KIm05joYXynqzUgbsG5nMrj/xEFAHXkeZfO3yMK8QQ+mP7p1/",
        () => cdnScript(
          "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js",
          "sha384-Xl/CUCfJbzsngMp0CFxkmF0VW/8C160IsGujqeQlIhaGxKz2+JsIGORFqtCPeldF",
          () => resolve(window.jspdf.jsPDF),
          fail
        ),
        fail
      );
    });
  }
  return jspdfPromise;
}
