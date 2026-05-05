let trackerDomains = null;   // Set<string> once loaded; null while loading
const pendingNodes  = [];    // nodes queued before domains finish loading

// allowlisted despite appearing in filter lists — EasyList option filters restrict them but tracker-guard cannot parse options
const TRACKER_ALLOWLIST = new Set([
  "ajax.googleapis.com",   // Google AJAX CDN (jQuery, Angular, etc.)
  "maps.googleapis.com",   // Google Maps API
  "accounts.google.com",   // Google OAuth / sign-in
  "cdn.jsdelivr.net",      // open-source library CDN
  "fonts.googleapis.com",  // Google Fonts CSS
  "fonts.gstatic.com",     // Google Fonts assets
  "www.gstatic.com",       // Google static assets
]);

// hand-curated subset; long-term fix is bundling the Mozilla Public Suffix List
const MULTI_LABEL_TLDS = new Set([
  "co.uk","co.jp","co.nz","co.za","co.in","co.kr","co.id","co.il",
  "com.au","com.br","com.ar","com.mx","com.sg","com.hk","com.my",
  "net.au","org.au","gov.uk","ac.uk","me.uk","org.uk","ne.jp","or.jp",
]);

function getRootDomain(hostname) {
  const parts = hostname.split(".");
  if (parts.length >= 3 && MULTI_LABEL_TLDS.has(parts.slice(-2).join("."))) {
    return parts.slice(-3).join("."); // e.g. tracker.bbc.co.uk → bbc.co.uk
  }
  return parts.slice(-2).join(".");
}

const PAGE_ROOT_DOMAIN = getRootDomain(location.hostname.toLowerCase());

function isThirdParty(hostname) {
  return !!hostname && getRootDomain(hostname) !== PAGE_ROOT_DOMAIN;
}

function isTrackedDomain(hostname) {
  if (!trackerDomains || !hostname) return false;
  const h = hostname.toLowerCase();
  if (TRACKER_ALLOWLIST.has(h)) return false;
  let candidate = h;
  while (candidate.includes(".")) {
    if (trackerDomains.has(candidate)) return true;
    candidate = candidate.slice(candidate.indexOf(".") + 1);
  }
  return false;
}

function getSrcHostname(el) {
  const raw = el.src || el.data || "";
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return null;
  try {
    return new URL(raw, location.href).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function applyBlock(el, domain) {
  console.debug("[AdMask] Tracker detected:", domain, el);
  try {
    chrome.runtime.sendMessage({
      type:     "admask:reportHit",
      selector: domain,
      source:   "tracker",
      hostname: location.hostname,
    });
  } catch (_) {
    // Extension context invalidated after extension reload — safe to swallow.
  }
}

const TRACKABLE_SELECTOR = "script[src], iframe[src], embed[src], object[data], img[src]";

function guardNode(root) {
  if (!root || root.nodeType !== 1) return;

  const tag = root.tagName;
  if (tag === "SCRIPT" || tag === "IFRAME" || tag === "EMBED" || tag === "OBJECT" || tag === "IMG") {
    const hostname = getSrcHostname(root);
    if (hostname && isThirdParty(hostname) && isTrackedDomain(hostname)) {
      applyBlock(root, hostname);
      return; // children of a blocked element are irrelevant
    }
  }

  for (const el of root.querySelectorAll(TRACKABLE_SELECTOR)) {
    const hostname = getSrcHostname(el);
    if (hostname && isThirdParty(hostname) && isTrackedDomain(hostname)) {
      applyBlock(el, hostname);
    }
  }
}

function processPending() {
  const batch = pendingNodes.splice(0);
  for (const node of batch) guardNode(node);
}

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (trackerDomains) {
        guardNode(node);
      } else {
        pendingNodes.push(node);
      }
    }
  }
});

// document.documentElement exists at document_start
observer.observe(document.documentElement, { childList: true, subtree: true });

chrome.storage.session.get(["admask:tracker-domains", `admask:bypass:${location.hostname}`]).then((data) => {
  if (data[`admask:bypass:${location.hostname}`]) {
    trackerDomains = new Set();
    console.debug("[AdMask] Tracker guard bypassed on", location.hostname);
    return;
  }

  const list = data["admask:tracker-domains"];
  if (list?.length) {
    trackerDomains = new Set(list);
    console.debug("[AdMask] Tracker guard ready,", trackerDomains.size, "domains (session)");
    processPending();
    guardNode(document.documentElement);
    return;
  }

  // cold start — session empty, ask background; response includes bypass flag
  chrome.runtime.sendMessage({ type: "admask:getTrackerDomains" }, (response) => {
    if (chrome.runtime.lastError) {
      console.debug("[AdMask] Tracker guard: service worker unavailable:", chrome.runtime.lastError.message);
      trackerDomains = new Set(); // fail open — better than crashing
      // bypass already checked above; skip duplicating the list inline
      processPending();
      return;
    }
    if (response?.bypass) {
      trackerDomains = new Set();
      console.debug("[AdMask] Tracker guard bypassed on", location.hostname, "(cold)");
      return;
    }
    trackerDomains = new Set(response?.domains ?? []);
    console.debug("[AdMask] Tracker guard ready,", trackerDomains.size, "domains (cold)");
    processPending();
    guardNode(document.documentElement);
  });
});
