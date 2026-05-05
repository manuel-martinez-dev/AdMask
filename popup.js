document.querySelector(".version").textContent = "v" + chrome.runtime.getManifest().version;

const cntCss     = document.getElementById("cnt-css");
const cntTracker = document.getElementById("cnt-tracker");
const cntSnippet = document.getElementById("cnt-snippet");
const hostnameEl = document.getElementById("hostname");
const hitsList   = document.getElementById("hits-list");
const emptyEl    = document.getElementById("empty");
const downloadBtn = document.getElementById("download-btn");
const clearBtn   = document.getElementById("clear-btn");

let currentHits = [];
let currentHostname = "";

function render(hits, tabHostname) {
  currentHits = hits;
  currentHostname = tabHostname ?? "";

  const byCss     = hits.filter((h) => h.source === "css");
  const byTracker = hits.filter((h) => h.source === "tracker");
  const bySnippet = hits.filter((h) => h.source === "snippet");

  cntCss.textContent     = byCss.length;
  cntTracker.textContent = byTracker.length;
  cntSnippet.textContent = bySnippet.length;

  hostnameEl.textContent = currentHostname || "";

  [...hitsList.querySelectorAll(".hit-row")].forEach((el) => el.remove());

  if (hits.length === 0) {
    emptyEl.style.display = "";
    downloadBtn.disabled = true;
    return;
  }

  emptyEl.style.display = "none";
  downloadBtn.disabled = false;

  const sorted = [...hits].sort((a, b) => b.ts - a.ts);
  for (const hit of sorted) {
    const row = document.createElement("div");
    row.className = "hit-row";

    const badge = document.createElement("span");
    badge.className = `badge ${hit.source}`;
    badge.textContent = hit.source;

    const sel = document.createElement("span");
    sel.className = "hit-selector";
    sel.textContent = hit.selector;

    row.appendChild(badge);
    row.appendChild(sel);

    if (hit.network) {
      const netTag = document.createElement("span");
      netTag.className = "network";
      netTag.textContent = hit.network;
      row.appendChild(netTag);
    }

    hitsList.appendChild(row);
  }
}

function buildReport(hits, tabHostname) {
  const now = new Date().toISOString();
  const lines = [];

  lines.push("# AdMask Filter Hit Report");
  lines.push("");
  lines.push(`- **Page:** ${tabHostname}`);
  lines.push(`- **Generated:** ${now}`);
  lines.push(`- **Total hits:** ${hits.length}`);
  lines.push("");

  const groups = {
    css:     hits.filter((h) => h.source === "css"),
    tracker: hits.filter((h) => h.source === "tracker"),
    snippet: hits.filter((h) => h.source === "snippet"),
  };

  for (const [source, group] of Object.entries(groups)) {
    if (!group.length) continue;
    lines.push(`## ${source.toUpperCase()} hits (${group.length})`);
    lines.push("");

    lines.push("| Selector / Domain | Network | Time |");
    lines.push("|---|---|---|");
    for (const hit of group) {
      const t       = new Date(hit.ts).toISOString().slice(11, 23);
      const sel     = hit.selector.replace(/[`|]/g, (c) => "\\" + c);
      const network = (hit.network ?? "—").replace(/\|/g, "\\|");
      lines.push(`| \`${sel}\` | ${network} | ${t} |`);
    }

    lines.push("");
  }

  if (groups.tracker.length) {
    const freq = {};
    for (const hit of groups.tracker) {
      freq[hit.selector] = (freq[hit.selector] ?? 0) + 1;
    }
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    lines.push("## Tracker domain frequency");
    lines.push("");
    lines.push("| Domain | Count |");
    lines.push("|---|---|");
    for (const [domain, count] of sorted) {
      lines.push(`| \`${domain.replace(/[`|]/g, (c) => "\\" + c)}\` | ${count} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function downloadReport() {
  if (!currentHits.length) return;

  const md = buildReport(currentHits, currentHostname);
  const blob = new Blob([md], { type: "text/markdown" });
  const url  = URL.createObjectURL(blob);

  const safe = currentHostname.replace(/[^a-z0-9.-]/gi, "_") || "unknown";
  const ts   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  chrome.downloads.download({
    url,
    filename: `admask-report-${safe}-${ts}.md`,
    saveAs: false,
  }, () => {
    URL.revokeObjectURL(url);
    if (chrome.runtime.lastError) console.warn('[AdMask] Download failed:', chrome.runtime.lastError.message);
  });
}

async function load() {
  const [tabs] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tabHostname = "";
  if (tabs?.url) { try { tabHostname = new URL(tabs.url).hostname; } catch {} }

  chrome.runtime.sendMessage({ type: "admask:getHits" }, (response) => {
    if (chrome.runtime.lastError) {
      render([], tabHostname);
      return;
    }
    render(response?.hits ?? [], tabHostname);
  });
}

downloadBtn.addEventListener("click", downloadReport);

clearBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "admask:clearHits" });
  render([], currentHostname);
  downloadBtn.disabled = true;
});

load();
