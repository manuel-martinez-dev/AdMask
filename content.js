// prevents re-masking elements the user has explicitly shown
const restored = new WeakSet();
// prevents re-masking after "Show ad" — breaks the ad-recreation loop
const restoredSelectors = new Set();

let lastContextMenuTarget = null;
document.addEventListener("contextmenu", (e) => { lastContextMenuTarget = e.target; }, true);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "admask:captureContextTarget") return;
  if (!lastContextMenuTarget || lastContextMenuTarget.closest("[data-admask-wrapper]")) {
    sendResponse({ selector: null });
    return;
  }
  const selector = extractLearnedSelector(lastContextMenuTarget);
  sendResponse({ selector, hostname });
});

const PLACEHOLDER_SRCDOC = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:rgba(120,120,120,0.55)}</style>
</head><body></body></html>`;

function replaceWithPlaceholder(detectedAd) {
  const { el, selector } = detectedAd;
  if (!el || !el.parentNode) return false;
  if (restored.has(el)) return false;

  const rect = el.getBoundingClientRect();
  const computed = getComputedStyle(el);

  // 10px floor — collapsed GPT slots measure 0 before the ad iframe expands layout
  let width  = rect.width  >= 10 ? rect.width  : (parseInt(computed.width)  || 0);
  let height = rect.height >= 10 ? rect.height : (parseInt(computed.height) || 0);
  if (width < 10 || height < 10) {
    const childIframe = el.querySelector("iframe");
    if (childIframe) {
      const fw = parseInt(childIframe.getAttribute("width"));
      const fh = parseInt(childIframe.getAttribute("height"));
      if (width  < 10 && fw > 0) width  = fw;
      if (height < 10 && fh > 0) height = fh;
    }
  }
  width  = width  || 300;
  height = height || 100;

  const wrapper = document.createElement("div");
  wrapper.dataset.admaskWrapper = "1"; // lets the context menu guard skip our own elements
  wrapper.style.cssText = `
    display: block;
    width: ${width}px;
    height: ${height}px;
    margin: 0;
    padding: 0;
    overflow: hidden;
    position: ${computed.position === "static" ? "relative" : computed.position};
  `;
  // only positioned elements use offset properties — relative elements ignore them
  if (computed.position === "absolute" || computed.position === "fixed" || computed.position === "sticky") {
    wrapper.style.top    = computed.top;
    wrapper.style.left   = computed.left;
    wrapper.style.right  = computed.right;
    wrapper.style.bottom = computed.bottom;
    wrapper.style.zIndex = computed.zIndex;
  }

  const iframe = document.createElement("iframe");
  iframe.style.cssText = `
    display: block;
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    border: none; margin: 0; padding: 0; overflow: hidden;
  `;
  iframe.srcdoc = PLACEHOLDER_SRCDOC;

  // overlay handles clicks in ISOLATED world — immune to page CSP
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    cursor: pointer;
    z-index: 2147483647;
    font-family: system-ui, sans-serif;
    text-align: center;
    user-select: none;
  `;

  const adLabel = document.createElement("span");
  adLabel.textContent = "ad here";
  adLabel.style.cssText = `
    font-size: 13px; font-weight: 600; letter-spacing: 0.04em;
    color: rgba(255,255,255,0.9); pointer-events: none;
  `;

  const showBtn = document.createElement("button");
  showBtn.textContent = "Show ad";
  showBtn.style.cssText = `
    font-size: 11px; padding: 3px 10px;
    border: 1px solid rgba(255,255,255,0.7); border-radius: 3px;
    background: rgba(255,255,255,0.15); color: #fff;
    cursor: pointer; pointer-events: none;
  `;

  overlay.addEventListener("mouseenter", () => { showBtn.style.background = "rgba(255,255,255,0.3)"; });
  overlay.addEventListener("mouseleave", () => { showBtn.style.background = "rgba(255,255,255,0.15)"; });

  overlay.appendChild(adLabel);
  overlay.appendChild(showBtn);

  overlay.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const parent = wrapper.parentNode;
    if (!parent) return;
    // add to restored before re-inserting — observer fires between insertBefore and removeChild
    restored.add(el);
    restoredSelectors.add(selector); // honour user intent — don't re-mask this selector
    el.style.pointerEvents = "none";
    parent.insertBefore(el, wrapper);
    parent.removeChild(wrapper);
    setTimeout(() => { el.style.pointerEvents = ""; }, 100);
  });

  wrapper.appendChild(iframe);
  wrapper.appendChild(overlay);

  const parent = el.parentNode;
  if (!parent) return false;
  parent.insertBefore(wrapper, el);
  parent.removeChild(el);
  return true;
}

const hostname = location.hostname;
let rules = [];

async function loadHostnameData() {
  const rulesKey   = `admask:rules:${hostname}`;
  const snippetsKey = `admask:snippets:${hostname}`;
  const bypassKey  = `admask:bypass:${hostname}`;

  const session = await chrome.storage.session.get([rulesKey, snippetsKey, bypassKey]);
  if (session[bypassKey]) return { bypass: true, rules: [], snippets: [] };
  if (session[rulesKey]?.length || session[snippetsKey]?.length) {
    return { rules: session[rulesKey] ?? [], snippets: session[snippetsKey] ?? [] };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "admask:getHostnameData", hostname }, (response) => {
      if (chrome.runtime.lastError) {
        console.debug("[AdMask] Service worker unavailable:", chrome.runtime.lastError.message);
        resolve({ rules: [], snippets: [] });
        return;
      }
      resolve({
        bypass:   response?.bypass   ?? false,
        rules:    response?.rules    ?? [],
        snippets: response?.snippets ?? [],
      });
    });
  });
}

const LAYOUT_CONTAINER_VIEWPORT_RATIO = 0.85;

const AD_SMELL_RE = /\b(ad|ads|advert|advertisement|sponsor|sponsored|promo|banner|commercial)\b/i;

const NETWORK_PATTERNS = [
  [/adthrive/i,                                          "AdThrive"],
  [/taboola|trc[_-]/i,                                   "Taboola"],
  [/outbrain|ob-dynamic/i,                               "Outbrain"],
  [/freestar/i,                                          "FreeStar"],
  [/adsbygoogle|googlesyndication|google_ads|\bdfp\b|data-google-/i, "Google"],
  [/publift|adsbypublift/i,                              "Publift"],
  [/adsbyadop/i,                                         "Adop"],
  [/adstub/i,                                            "AdStub"],
  [/\[status=["']?success/i,                             "Ad-Shield"],
];

const NETWORK_HOSTNAMES = [
  [/(?:^|\.)html-load\.com$/,          "html-load.com"],
  [/(?:^|\.)css-load\.com$/,           "css-load.com"],
  [/(?:^|\.)googlesyndication\.com$/,  "Google"],
  [/(?:^|\.)doubleclick\.net$/,        "Google DFP"],
  [/(?:^|\.)amazon-adsystem\.com$/,    "Amazon"],
  [/(?:^|\.)taboola\.com$/,            "Taboola"],
  [/(?:^|\.)outbrain\.com$/,           "Outbrain"],
  [/(?:^|\.)adthrive\.com$/,           "AdThrive"],
];

function adSmell(str) {
  return !!str && AD_SMELL_RE.test(str);
}

function elSrcHostname(el) {
  const raw = el.src || el.getAttribute("data-src") || "";
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return null;
  try { return new URL(raw, location.href).hostname.toLowerCase(); } catch { return null; }
}

// Renamed to avoid a SyntaxError clash with tracker-guard.js's MULTI_LABEL_TLDS in the shared ISOLATED scope.
const _CONTENT_MULTI_LABEL_TLDS = new Set([
  "co.uk","co.jp","co.nz","co.za","co.in","co.kr","co.id","co.il",
  "com.au","com.br","com.ar","com.mx","com.sg","com.hk","com.my",
  "net.au","org.au","gov.uk","ac.uk","me.uk","org.uk","ne.jp","or.jp",
]);

function getRootDomain(hostname) {
  const parts = hostname.split(".");
  if (parts.length >= 3 && _CONTENT_MULTI_LABEL_TLDS.has(parts.slice(-2).join("."))) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function isThirdPartySrc(srcHostname) {
  if (!srcHostname) return false;
  return getRootDomain(srcHostname) !== getRootDomain(location.hostname.toLowerCase());
}

function extractAdNetwork(el, selector) {
  for (const [re, name] of NETWORK_PATTERNS) {
    if (re.test(selector)) return name;
  }
  const matchHostname = (h) => {
    if (!h) return null;
    for (const [re, name] of NETWORK_HOSTNAMES) {
      if (re.test(h)) return name;
    }
    return null;
  };
  const own = matchHostname(elSrcHostname(el));
  if (own) return own;
  for (const child of el.querySelectorAll("iframe, img")) {
    const n = matchHostname(elSrcHostname(child));
    if (n) return n;
  }
  return null;
}

function isStableIdentifier(str) {
  if (!str || str.length < 3 || str.length > 60) return false;
  if (/[a-f0-9]{8,}/i.test(str)) return false; // looks like a hash/token
  if (/^\d+$/.test(str)) return false;           // pure numeric
  return true;
}

function extractLearnedSelector(el) {
  for (const a of el.attributes) {
    if (a.name.startsWith("data-ad-") ||
        a.name.startsWith("data-google-") ||
        a.name.startsWith("data-dfp-") ||
        a.name === "bid") return `[${a.name}]`;
  }
  if (el.id && isStableIdentifier(el.id)) return `#${CSS.escape(el.id)}`;
  const classes = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean) : [];
  const adClasses = classes.filter(c => isStableIdentifier(c) && AD_SMELL_RE.test(c));
  if (adClasses.length) return adClasses.map(c => `.${CSS.escape(c)}`).join("");

  // Ad-Shield sets status="success" dynamically — stable signal with no class/id
  if (el.tagName === "IFRAME" && el.getAttribute("status") === "success")
    return 'iframe[status="success"]';

  return null; // no ad-smell class — generic classes are too broad to store safely
}

function scanSubtree(root) {
  if (!root || root.nodeType !== 1) return;
  for (const selector of rules) {
    try {
      if (root.matches(selector) && !restored.has(root)) {
        if (handleMatch(root, selector)) return;
      }
      const matches = root.querySelectorAll(selector);
      for (const el of matches) {
        if (!restored.has(el)) handleMatch(el, selector);
      }
    } catch (e) {
      if (!(e instanceof SyntaxError)) console.error("[AdMask] scanSubtree error:", e);
    }
  }
}

function reportHit(selector, source, confidence, reason, network) {
  chrome.runtime.sendMessage({
    type:     "admask:reportHit",
    selector,
    source,
    hostname,
    ...(confidence != null && { confidence }),
    ...(reason     != null && { reason }),
    ...(network    != null && { network }),
  });
}

function elementHasAdSignal(el) {
  const cls = typeof el.className === "string" ? el.className : "";
  if (adSmell(cls) || adSmell(el.id)) return true;
  const parent = el.parentElement;
  if (parent) {
    const pcls = typeof parent.className === "string" ? parent.className : "";
    if (adSmell(pcls) || adSmell(parent.id)) return true;
  }
  for (const a of el.attributes) {
    if (a.name.startsWith("data-ad-") ||
        a.name.startsWith("data-google-") ||
        a.name.startsWith("data-dfp-") ||
        a.name === "bid") return true;
  }
  for (const child of el.children) {
    if (child.tagName === "IFRAME" || child.tagName === "IMG") {
      const sh = elSrcHostname(child);
      if (sh && isThirdPartySrc(sh)) return true;
    } else if (child.children.length === 0) {
      const text = child.textContent?.trim().toUpperCase();
      if (text === "AD" || text === "ADVERTISEMENT" || text === "SPONSORED" || text === "PROMOTED") return true;
    }
  }
  const sh = elSrcHostname(el);
  if (sh && isThirdPartySrc(sh)) return true;
  return false;
}

function handleMatch(el, selector) {
  if (restoredSelectors.has(selector)) return false;
  // skip layout containers — global rules like ##.w-full match Tailwind wrappers, not ad slots
  const rect = el.getBoundingClientRect();
  if (rect.width  > window.innerWidth  * LAYOUT_CONTAINER_VIEWPORT_RATIO &&
      rect.height > window.innerHeight * LAYOUT_CONTAINER_VIEWPORT_RATIO) return false;

  // vendor names in camelCase (e.g. FreeStarVideoAdContainer) don't match \b word boundaries in AD_SMELL_RE
  const selHasSmell = AD_SMELL_RE.test(selector) ||
                      NETWORK_PATTERNS.some(([re]) => re.test(selector));
  if (!selHasSmell && !elementHasAdSignal(el)) return false;

  const network = extractAdNetwork(el, selector);
  console.debug("[AdMask] Ad detected:", selector, el);
  const masked = replaceWithPlaceholder({ el, selector, source: "css" });
  if (masked) reportHit(selector, "css", null, null, network);
  return masked;
}

function handleSnippetMatch(el) {
  const ruleName = el.dataset.admaskSnippet || "snippet";
  if (restoredSelectors.has(ruleName)) return;
  const network = extractAdNetwork(el, ruleName);
  console.debug("[AdMask] Snippet match:", ruleName, el);
  if (replaceWithPlaceholder({ el, selector: ruleName, source: "snippet" })) reportHit(ruleName, "snippet", null, null, network);
}

let pending = [];
let timer = null;

function startObserver() {
  const observer = new MutationObserver((mutations) => {
    try {
      for (const m of mutations) {
        if (m.type === "childList") {
          for (const node of m.addedNodes)
            if (node.nodeType === 1) pending.push(node);
        } else if (m.type === "attributes") {
          const el = m.target;
          if (el.dataset.admaskSnippet && !restored.has(el))
            handleSnippetMatch(el);
          // data-load-complete signals GPT slot fully rendered — walk up to the outer slot container
          if (m.attributeName === "data-load-complete" && el.dataset.loadComplete === "true") {
            const gptSlot = el.closest("[data-google-query-id]");
            if (gptSlot && !restored.has(gptSlot)) {
              pending.push(gptSlot);
            }
          }
          // Ad-Shield sets status="success" once recovery ad loads
          if (m.attributeName === "status" &&
              el.tagName === "IFRAME" &&
              el.getAttribute("status") === "success" &&
              !restored.has(el)) {
            handleMatch(el, 'iframe[status="success"]');
          }
        }
      }
    } catch (err) {
      console.error("[AdMask] MutationObserver error (observer continues):", err);
    }
    clearTimeout(timer);
    timer = setTimeout(processPending, 50);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-admask-snippet", "data-load-complete", "status"],
  });
}

function processPending() {
  const batch = pending.splice(0);
  for (const node of batch) {
    if (node.nodeType !== 1) continue;
    scanSubtree(node);
  }
}

(async function init() {
  const { bypass, rules: cssRules, snippets } = await loadHostnameData();

  if (bypass) {
    console.debug("[AdMask] Bypassed on", hostname, "— extension inactive on this site.");
    return;
  }

  // [data-google-query-id] is set exclusively by Google Publisher Tag on GPT ad slots
  const VENDOR_RULES = ["[data-google-query-id]", 'iframe[status="success"]', "[bid]"];
  rules = [...cssRules, ...VENDOR_RULES];

  startObserver();

  if (rules.length || snippets.length) {
    if (rules.length) {
      console.debug("[AdMask] Loaded", rules.length, "selectors for", hostname);
      scanSubtree(document.body);
    }

    // periodic fallback catches elements whose ad class was set after insertion (SPAs, React)
    if (rules.length) {
      const scanInterval = setInterval(() => { if (!document.hidden) scanSubtree(document.body); }, 2000);
      window.addEventListener('pagehide', () => clearInterval(scanInterval), { once: true });
    }

    // pick up any elements MAIN world marked before our observer started (edge case)
    document.querySelectorAll("[data-admask-snippet]").forEach((el) => {
      if (!restored.has(el)) handleSnippetMatch(el);
    });

    if (snippets.length) {
      console.debug("[AdMask] Loaded", snippets.length, "snippet rules for", hostname);
      // CustomEvent is the only ISOLATED→MAIN channel; page scripts can also fire it (inherent MV3 constraint).
      setTimeout(() => {
        document.dispatchEvent(new CustomEvent("admask:snippets", { detail: { rules: snippets } }));
      }, 0);
    }
  } else {
    console.debug("[AdMask] No CSS/snippet rules for", hostname);
  }
})();
