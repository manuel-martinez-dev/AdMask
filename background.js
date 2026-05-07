import { FILTER_LIST_URLS, REFRESH_INTERVAL_MINUTES, BYPASS_HOSTNAMES } from "./config.js";

function isBypassed(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return BYPASS_HOSTNAMES.some((entry) =>
    h === entry || h.endsWith("." + entry)
  );
}

chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });

chrome.runtime.onInstalled.addListener(async () => {
  await refreshRules();
  chrome.alarms.create("admask-refresh", { periodInMinutes: REFRESH_INTERVAL_MINUTES });
  // removeAll is idempotent across installs and updates.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:                  "admask-mark-ad",
      title:               "AdMask: mark as ad",
      contexts:            ["all"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "admask-refresh") refreshRules();
});

const MAX_LEARNED_PER_HOSTNAME = 50;

async function storeLearnedSelector(hostname, selector) {
  if (!hostname || !selector) return;
  const key = `admask:learned:${hostname}`;
  try {
    const data = await chrome.storage.local.get(key);
    const existing = data[key] ?? [];
    if (existing.includes(selector)) return; // already known
    if (existing.length >= MAX_LEARNED_PER_HOSTNAME) {
      console.warn("[AdMask] Learned selector cap reached for", hostname, "— selector dropped:", selector);
      return;
    }
    existing.push(selector);
    await chrome.storage.local.set({ [key]: existing });
    await chrome.storage.session.remove(`admask:rules:${hostname}`);
    console.log("[AdMask] Learned selector stored:", hostname, selector);
  } catch (err) {
    console.error("[AdMask] Failed to store learned selector:", err);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "admask-mark-ad" || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "admask:captureContextTarget" }, (response) => {
    if (chrome.runtime.lastError || !response?.selector) return;
    storeLearnedSelector(response.hostname, response.selector);
  });
});

async function refreshRules() {
  const compiled = await fetchAndParseStandalone();
  if (!compiled) return;

  const { trackerDomains, ...rulesData } = compiled;

  // Preserve previous data when one list fails and its category comes back empty.
  const existing = await chrome.storage.local
    .get(["admask:rules", "admask:tracker-domains"])
    .catch(() => ({}));

  const finalRulesData = Object.keys(rulesData.rules ?? {}).length > 0
    ? rulesData
    : (existing["admask:rules"] ?? rulesData);

  const finalDomains = trackerDomains?.length > 0
    ? trackerDomains
    : (existing["admask:tracker-domains"] ?? []);

  if (Object.keys(rulesData.rules ?? {}).length === 0 && existing["admask:rules"])
    console.warn("[AdMask] CSS rules empty after refresh — preserving previous rules.");
  if (!trackerDomains?.length && existing["admask:tracker-domains"]?.length)
    console.warn("[AdMask] Tracker domains empty after refresh — preserving previous domains.");

  await chrome.storage.local.set({
    "admask:rules":           finalRulesData,
    "admask:compiled":        Date.now(),
    "admask:tracker-domains": finalDomains,
  }).catch((err) => console.error("[AdMask] Failed to persist rules to local storage:", err));

  if (finalDomains?.length) {
    await chrome.storage.session.set({ "admask:tracker-domains": finalDomains })
      .catch((err) => console.error("[AdMask] Failed to persist tracker domains to session:", err));
  }

  console.log("[AdMask] Rules refreshed — hostnames:", Object.keys(finalRulesData.rules ?? {}).length, "snippets:", Object.keys(finalRulesData.snippets ?? {}).length, "tracker domains:", finalDomains.length);
}

async function fetchAndParseStandalone() {
  const allSelectors = {}; // { hostname: Set<selector> }
  const trackerSet = new Set();
  const allSnippets = {}; // { hostname: [[name, ...args]] }

  const fetches = await Promise.allSettled(
    FILTER_LIST_URLS.map((url) =>
      fetch(url).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
    )
  );

  let succeeded = 0;
  for (let i = 0; i < fetches.length; i++) {
    const result = fetches[i];
    if (result.status === "rejected") {
      console.error("[AdMask] Failed to fetch filter list:", FILTER_LIST_URLS[i], result.reason);
      continue;
    }
    succeeded++;
    await parseFilterListText(result.value, allSelectors, allSnippets, trackerSet);
  }

  if (succeeded === 0) {
    console.warn("[AdMask] All filter-list fetches failed — existing rules preserved, refresh skipped.");
    return null;
  }

  const rules = {};
  for (const [host, selectors] of Object.entries(allSelectors)) {
    rules[host] = [...selectors];
  }

  return { compiled: new Date().toISOString(), rules, snippets: allSnippets, trackerDomains: [...trackerSet] };
}

async function parseFilterListText(text, selectors, snippets, domains) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % 5000 === 0) await new Promise(r => setTimeout(r));
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("!")) continue;

    if (trimmed.startsWith("||")) {
      const m = trimmed.match(/^\|\|([a-z0-9][-a-z0-9.]*\.[a-z]{2,})[/^$]/i);
      if (m) domains.add(m[1].toLowerCase());
      const hhIdx = trimmed.indexOf("##");
      if (hhIdx !== -1 && m?.[1]) {
        const sel = trimmed.slice(hhIdx + 2).trim();
        if (sel) {
          if (!selectors[m[1]]) selectors[m[1]] = new Set();
          selectors[m[1]].add(sel);
        }
      }
      continue;
    }

    const snippetSep = trimmed.indexOf("#$#");
    if (snippetSep !== -1) {
      const hostPart   = trimmed.slice(0, snippetSep).trim();
      const scriptPart = trimmed.slice(snippetSep + 3).trim();
      if (hostPart && scriptPart) {
        const commands = parseSnippetCommands(scriptPart);
        if (commands.length) {
          for (const host of hostPart.split(",").map(h => h.trim())) {
            if (host.startsWith("~")) continue;
            if (!snippets[host]) snippets[host] = [];
            snippets[host].push(...commands);
          }
        }
      }
      continue;
    }

    const hashHash = trimmed.indexOf("##");
    if (hashHash === -1) continue;
    const hostPart = trimmed.slice(0, hashHash).trim();
    const selector = trimmed.slice(hashHash + 2).trim();
    if (selector.startsWith("+js(") || selector.startsWith("+css(")) continue;
    const hosts = hostPart ? hostPart.split(",").map(h => h.trim()) : ["*"];
    for (const host of hosts) {
      if (host.startsWith("~")) continue;
      if (!selectors[host]) selectors[host] = new Set();
      selectors[host].add(selector);
    }
  }
}

function splitOnUnquotedSemicolons(str) {
  const parts = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\\" && inQuote) { cur += ch + (str[++i] ?? ""); }
    else if (ch === "\"") { inQuote = !inQuote; cur += ch; }
    else if (ch === ";" && !inQuote) { parts.push(cur); cur = ""; }
    else { cur += ch; }
  }
  if (cur) parts.push(cur);
  return parts;
}

function parseSnippetCommands(scriptPart) {
  const result = [];
  for (const raw of splitOnUnquotedSemicolons(scriptPart)) {
    const tokens = tokeniseSnippetArgs(raw.trim());
    if (tokens.length) result.push(tokens);
  }
  return result;
}

function tokeniseSnippetArgs(str) {
  const tokens = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\\" && inQuote) {
      current += str[++i] ?? "";
    } else if (ch === "\"") {
      inQuote = !inQuote;
    } else if (ch === " " && !inQuote) {
      if (current) { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

const tabHits = new Map();
const MAX_HITS_PER_TAB = 500;

// In-memory; SW restart drops it, causing one missed stale-session cleanup.
const tabHostnames = new Map();

function removeHostnameFromSession(hostname) {
  chrome.storage.session.remove([
    `admask:rules:${hostname}`,
    `admask:snippets:${hostname}`,
    `admask:bypass:${hostname}`,
  ]);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const hostname = tabHostnames.get(tabId);
  tabHits.delete(tabId);
  tabHostnames.delete(tabId);
  chrome.storage.session.remove(`admask:hits:${tabId}`);
  if (hostname) removeHostnameFromSession(hostname);
});

chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url }) => {
  if (frameId !== 0) return; // top frame only
  tabHits.delete(tabId);
  chrome.storage.session.remove(`admask:hits:${tabId}`);
  const prevHostname = tabHostnames.get(tabId);
  if (prevHostname) removeHostnameFromSession(prevHostname);
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return; }
  tabHostnames.set(tabId, hostname);
  await writeHostnameToSession(hostname).catch(err =>
    console.error("[AdMask] Failed to write session:", err)
  );
});

const MULTI_LABEL_TLDS = new Set([
  "co.uk","co.jp","co.nz","co.za","co.in","co.kr","co.id","co.il",
  "com.au","com.br","com.ar","com.mx","com.sg","com.hk","com.my",
  "net.au","org.au","gov.uk","ac.uk","me.uk","org.uk","ne.jp","or.jp",
]);

function getParentDomains(hostname) {
  const parents = [];
  let h = hostname;
  while (h.includes('.')) {
    h = h.slice(h.indexOf('.') + 1);
    if (!h.includes('.')) break;         // bare TLD — stop
    if (MULTI_LABEL_TLDS.has(h)) break; // known public suffix — stop
    parents.push(h);
  }
  return parents;
}

async function writeHostnameToSession(hostname) {
  if (isBypassed(hostname)) {
    await chrome.storage.session.set({ [`admask:bypass:${hostname}`]: true });
    return;
  }
  const stored = await chrome.storage.local.get(["admask:rules", `admask:learned:${hostname}`]);
  const storedRules = stored["admask:rules"];
  if (!storedRules?.rules) return;

  const learnedRules = stored[`admask:learned:${hostname}`] ?? [];
  const parents = getParentDomains(hostname);
  const hostRules = [
    ...(storedRules.rules[hostname] ?? []),
    ...parents.flatMap(p => storedRules.rules[p] ?? []),
    ...(storedRules.rules["*"] ?? []),
    ...learnedRules,
  ];

  const hostSnippets = [
    ...(storedRules.snippets?.[hostname] ?? []),
    ...parents.flatMap(p => storedRules.snippets?.[p] ?? []),
  ];

  await chrome.storage.session.set({
    [`admask:rules:${hostname}`]: hostRules,
    [`admask:snippets:${hostname}`]: hostSnippets,
  });
}

const CONTENT_SCRIPT_MESSAGES = new Set([
  "admask:getHostnameData",
  "admask:reportHit",
  "admask:getTrackerDomains",
]);

const EXTENSION_PAGE_MESSAGES = new Set([
  "admask:getHits",
  "admask:clearHits",
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (CONTENT_SCRIPT_MESSAGES.has(msg.type) && !sender.tab) return;
  if (EXTENSION_PAGE_MESSAGES.has(msg.type) &&  sender.tab) return;

  if (msg.type === "admask:getHostnameData") {
    const hostname = msg.hostname;
    if (isBypassed(hostname)) {
      sendResponse({ bypass: true, rules: [], snippets: [] });
      return true;
    }
    writeHostnameToSession(hostname).then(() => {
      chrome.storage.session.get([
        `admask:rules:${hostname}`,
        `admask:snippets:${hostname}`,
      ]).then((data) => {
        sendResponse({
          rules:    data[`admask:rules:${hostname}`]    ?? [],
          snippets: data[`admask:snippets:${hostname}`] ?? [],
        });
      });
    });
    return true; // keep message channel open for async response
  }

  if (msg.type === "admask:reportHit") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    if (!tabHits.has(tabId)) tabHits.set(tabId, []);
    const hits = tabHits.get(tabId);
    const dupeCount = hits.filter(h => h.selector === msg.selector && h.source === msg.source).length;
    if (dupeCount >= 3) return;
    if (hits.length < MAX_HITS_PER_TAB) {
      hits.push({
        selector:   msg.selector,
        source:     msg.source,
        hostname:   msg.hostname,
        ts:         Date.now(),
        ...(msg.confidence != null && { confidence: msg.confidence }),
        ...(msg.reason     != null && { reason:     msg.reason }),
        ...(msg.network    != null && { network:    msg.network }),
      });
      // Persist to session so hits survive SW termination.
      chrome.storage.session.set({ [`admask:hits:${tabId}`]: hits });
    }
    return; // no async response needed
  }

  if (msg.type === "admask:clearHits") {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId != null) {
        tabHits.delete(tabId);
        chrome.storage.session.remove(`admask:hits:${tabId}`);
      }
    });
    return;
  }

  if (msg.type === "admask:getTrackerDomains") {
    const url = sender.tab?.url;
    let hostname = "";
    try { if (url) hostname = new URL(url).hostname; } catch (err) { console.error("[AdMask] Failed to parse sender URL:", err); }
    if (isBypassed(hostname)) {
      sendResponse({ bypass: true, domains: [] });
      return true;
    }
    chrome.storage.local.get("admask:tracker-domains").then((data) => {
      sendResponse({ bypass: false, domains: data["admask:tracker-domains"] ?? [] });
    });
    return true;
  }

  if (msg.type === "admask:getHits") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId == null) { sendResponse({ hits: [] }); return; }
      let hits = tabHits.get(tabId);
      if (!hits) {
        const data = await chrome.storage.session.get(`admask:hits:${tabId}`);
        hits = data[`admask:hits:${tabId}`] ?? [];
        if (hits.length) tabHits.set(tabId, hits); // warm the in-memory cache
      }
      sendResponse({ hits });
    });
    return true;
  }
});
