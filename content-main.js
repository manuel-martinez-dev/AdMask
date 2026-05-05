(function() {

function markElement(el, ruleName) {
  if (!el || el.dataset.admaskSnippet) return;
  el.dataset.admaskSnippet = ruleName;
}

function makePattern(text) {
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  const lastSlash = text.lastIndexOf('/');
  if (lastSlash < 1) return null;
  try {
    return new RegExp(text.slice(1, lastSlash), text.slice(lastSlash + 1));
  } catch (_) {
    return null;
  }
}

function matches(pattern, literal, content) {
  return pattern ? pattern.test(content) : content.includes(literal);
}

function makePat(search) {
  if (!search) return null;
  return makePattern(search) ?? { test: s => s.includes(search) };
}

function resolveStub(name) {
  switch (name) {
    case 'noopFunc':   return () => {};
    case 'trueFunc':   return () => true;
    case 'falseFunc':  return () => false;
    case 'emptyObj':   return {};
    case 'emptyArray': return [];
    case 'null':       return null;
    case 'undefined':  return undefined;
    case 'true':       return true;
    case 'false':      return false;
  }
  const n = Number(name);
  return (!isNaN(n) && name !== '') ? n : undefined;
}

const SELECTOR_DEFAULT = '*:not(script):not(style):not(noscript):not(meta):not(link):not(head)';

function normalizeSel(selector) {
  return (!selector || selector === '*') ? SELECTOR_DEFAULT : selector;
}

function resolveTarget(el, hidingSelector) {
  return hidingSelector ? (el.closest(hidingSelector) ?? el) : el;
}

function queryAll(selector, roots) {
  if (!roots) return document.querySelectorAll(selector);
  const seen = new Set(), out = [];
  for (const root of roots) {
    try {
      if (root.matches(selector) && !seen.has(root)) { seen.add(root); out.push(root); }
      for (const el of root.querySelectorAll(selector)) {
        if (!seen.has(el)) { seen.add(el); out.push(el); }
      }
    } catch (_) {}
  }
  return out;
}

function hideIfContains(ruleName, text, selector = '*', hidingSelector = null, roots = null) {
  const pat = makePattern(text);
  for (const el of queryAll(normalizeSel(selector), roots)) {
    if (!matches(pat, text, el.textContent)) continue;
    markElement(resolveTarget(el, hidingSelector), ruleName);
  }
}

function hideIfContainsVisibleText(ruleName, text, selector = '*', hidingSelector = null, roots = null) {
  const pat = makePattern(text);
  for (const el of queryAll(normalizeSel(selector), roots)) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
    if (!matches(pat, text, el.textContent)) continue;
    markElement(resolveTarget(el, hidingSelector), ruleName);
  }
}

function hideIfHasAndMatchesStyle(ruleName, search, selector = '*', pseudo = null, property = null, value = null, roots = null) {
  const pat = makePattern(search);
  let valueRe = null;
  if (value) {
    const m = value.match(/^\/(.+)\/([gimsuy]*)$/);
    try { valueRe = m ? new RegExp(m[1], m[2]) : new RegExp(value); } catch (_) {}
  }
  for (const el of queryAll(normalizeSel(selector), roots)) {
    if (!matches(pat, search, el.textContent)) continue;
    if (property) {
      const propVal = getComputedStyle(el, pseudo || null).getPropertyValue(property);
      if (valueRe ? !valueRe.test(propVal) : !propVal) continue;
    }
    markElement(el, ruleName);
  }
}

function hideIfMatchesXPath(ruleName, xpath, roots = null) {
  if (!xpath) return;
  for (const ctx of (roots ?? [document])) {
    try {
      const result = document.evaluate(xpath, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < result.snapshotLength; i++) {
        const node = result.snapshotItem(i);
        if (node && node.nodeType === 1) markElement(node, ruleName);
      }
    } catch (_) {}
  }
}

function resolvePropertyChain(chain) {
  const parts = chain.split('.');
  const prop  = parts.pop();
  let obj = window;
  for (const part of parts) {
    if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) return null;
    obj = obj[part];
  }
  if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) return null;
  return { obj, prop };
}

// swallows errors so a bad rule never breaks the page
function defineOnChain(chain, defineFunc) {
  if (!chain) return;
  const resolved = resolvePropertyChain(chain);
  if (!resolved) return;
  const { obj, prop } = resolved;
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, prop);
    if (desc && !desc.configurable) return;
    defineFunc(obj, prop);
  } catch (_) {}
}

function abortOnPropertyRead(_ruleName, chain) {
  defineOnChain(chain, (obj, prop) => {
    Object.defineProperty(obj, prop, {
      get() { throw new ReferenceError('[AdMask] ' + chain + ' is not defined'); },
      configurable: true,
    });
  });
}

function abortOnPropertyWrite(_ruleName, chain) {
  defineOnChain(chain, (obj, prop) => {
    const current = obj[prop];
    Object.defineProperty(obj, prop, {
      get() { return current; },
      set() { throw new ReferenceError('[AdMask] ' + chain + ' is read-only'); },
      configurable: true,
    });
  });
}

function overridePropertyRead(_ruleName, chain, stubName = 'undefined', readOnlyStr = 'true') {
  const stub     = resolveStub(stubName);
  const readOnly = readOnlyStr !== 'false';
  defineOnChain(chain, (obj, prop) => {
    const descriptor = { get() { return stub; }, configurable: true };
    if (!readOnly) descriptor.set = () => {};
    Object.defineProperty(obj, prop, descriptor);
  });
}

function abortCurrentInlineScript(_ruleName, chain, search = null) {
  const pat = makePat(search);

  function shouldAbort() {
    const stack = new Error().stack || '';
    return !pat || pat.test(stack);
  }

  defineOnChain(chain, (obj, prop) => {
    const orig = obj[prop];
    if (typeof orig === 'function') {
      // Proxy created once — not on every property GET.
      const proxy = new Proxy(orig, {
        apply(target, thisArg, args) {
          if (shouldAbort()) throw new ReferenceError('[AdMask] ' + chain + ' aborted');
          return Reflect.apply(target, thisArg, args);
        },
        construct(target, args) {
          if (shouldAbort()) throw new ReferenceError('[AdMask] ' + chain + ' aborted');
          return Reflect.construct(target, args);
        },
      });
      Object.defineProperty(obj, prop, {
        get() { return proxy; },
        configurable: true,
      });
    } else {
      let current = orig;
      Object.defineProperty(obj, prop, {
        get() {
          if (shouldAbort()) throw new ReferenceError('[AdMask] ' + chain + ' aborted');
          return current;
        },
        set(v) { current = v; },
        configurable: true,
      });
    }
  });
}

const aeRules = [];
let aePatched = false;

// Cache listener.toString() — serialising large minified functions is expensive.
const listenerSrcCache = new WeakMap();

function ensureAEPatched() {
  if (aePatched) return;
  aePatched = true;
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, ...rest) {
    if (typeof listener !== 'function') return orig.call(this, type, listener, ...rest);
    let src = listenerSrcCache.get(listener);
    if (src === undefined) {
      src = listener.toString();
      listenerSrcCache.set(listener, src);
    }
    for (const rule of aeRules) {
      if (rule.eventType !== type) continue;
      if (rule.pattern && !rule.pattern.test(src)) continue;
      if (rule.type === 'prevent' || rule.action === 'disable') return;
      if (rule.action === 'trusted') {
        const wrapped = function(evt) { if (evt.isTrusted) return listener.call(this, evt); };
        return orig.call(this, type, wrapped, ...rest);
      }
    }
    return orig.call(this, type, listener, ...rest);
  };
}

function eventOverride(_ruleName, eventType, action = 'disable', search = null) {
  if (!eventType) return;
  aeRules.push({ type: 'override', eventType, action, pattern: makePat(search) });
  ensureAEPatched();
}

function preventListener(_ruleName, eventType, search = null) {
  if (!eventType) return;
  aeRules.push({ type: 'prevent', eventType, pattern: makePat(search) });
  ensureAEPatched();
}

const blobRules = [];
let blobPatched = false;

function blobOverride(_ruleName, searchPattern = null, replacement = '') {
  // page code capturing Blob before document_idle bypasses this entirely
  blobRules.push({ pat: makePat(searchPattern), replacement });
  if (blobPatched) return;
  blobPatched = true;
  try {
    const NativeBlob = Blob;
    const tagged = new WeakMap();

    function AdMaskBlob(parts = [], opts = {}) {
      const blob = new NativeBlob(parts, opts);
      const text = Array.isArray(parts)
        ? parts.map(p => (typeof p === 'string' ? p : '')).join('')
        : '';
      for (const rule of blobRules) {
        if (!rule.pat || rule.pat.test(text)) {
          tagged.set(blob, rule.replacement);
          break;
        }
      }
      return blob; // returning an object from `new` replaces the constructed instance
    }
    window.Blob = AdMaskBlob;

    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(obj) {
      if (obj instanceof NativeBlob) {
        const rep = tagged.get(obj);
        if (rep !== undefined) {
          return origCreate(new NativeBlob([rep], { type: obj.type }));
        }
      }
      return origCreate(obj);
    };
  } catch (_) {}
}

const xhrRules = [];
let xhrPatched = false;

function ensureXhrPatched() {
  if (xhrPatched) return;
  xhrPatched = true;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._admaskUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const url = this._admaskUrl ?? '';
    const applicable = xhrRules.filter(r => !r.urlPat || r.urlPat.test(url));
    if (applicable.length) {
      const handler = function() {
        if (this.readyState !== 4) return;
        this.removeEventListener('readystatechange', handler);
        let text = '';
        try { text = this.responseText; } catch (_) { return; }
        for (const rule of applicable) {
          if (rule.searchPat && !rule.searchPat.test(text)) continue;
          const rep = rule.replacement;
          Object.defineProperty(this, 'responseText', { get() { return rep; }, configurable: true });
          Object.defineProperty(this, 'response',     { get() { return rep; }, configurable: true });
          break;
        }
      };
      this.addEventListener('readystatechange', handler);
    }
    return origSend.call(this, ...args);
  };
}

function replaceXhrResponse(_ruleName, searchPattern = null, replacement = '', urlFilter = null) {
  xhrRules.push({ searchPat: makePat(searchPattern), replacement, urlPat: makePat(urlFilter) });
  ensureXhrPatched();
}

const elSrcRules = { script: [], iframe: [], img: [] };
const elSrcPatch  = {};

function preventElementSrcLoading(_ruleName, tagName, urlPattern) {
  if (!tagName || !urlPattern) return;
  const tag = tagName.toLowerCase();
  if (!elSrcRules[tag]) return;
  elSrcRules[tag].push(makePat(urlPattern) ?? { test: s => s.includes(urlPattern) });

  if (!elSrcPatch[tag]) {
    elSrcPatch[tag] = true;
    const proto = tag === 'script' ? HTMLScriptElement.prototype
                : tag === 'iframe' ? HTMLIFrameElement.prototype
                : HTMLImageElement.prototype;
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (!desc?.set) return;
      const origSet = desc.set;
      const rules   = elSrcRules[tag];
      Object.defineProperty(proto, 'src', {
        set(value) {
          if (rules.some(p => p.test(String(value ?? '')))) return;
          origSet.call(this, value);
        },
        get: desc.get,
        configurable: true,
      });
    } catch (_) {}
  }
}

const jsonPruneRules = [];
let jsonPrunePatched = false;

function ensureJsonPrunePatched() {
  if (jsonPrunePatched) return;
  jsonPrunePatched = true;
  const orig = JSON.parse.bind(JSON);
  JSON.parse = function(text, ...rest) {
    const result = orig(text, ...rest);
    if (typeof result !== 'object' || result === null) return result;
    for (const rule of jsonPruneRules) {
      if (rule.obligatory && !rule.obligatory.every(p => {
        return p.split('.').reduce((o, k) => o?.[k], result) !== undefined;
      })) continue;
      for (const prop of rule.props) {
        const parts = prop.split('.');
        const last  = parts.pop();
        const obj   = parts.reduce((o, k) => o?.[k], result);
        if (obj && typeof obj === 'object') delete obj[last];
      }
    }
    return result;
  };
}

function jsonPrune(_ruleName, propsToRemove, obligatoryProps = null) {
  if (!propsToRemove) return;
  jsonPruneRules.push({
    props:      propsToRemove.trim().split(/\s+/),
    obligatory: obligatoryProps ? obligatoryProps.trim().split(/\s+/) : null,
  });
  ensureJsonPrunePatched();
}

function cookieRemover(_ruleName, pattern, reloadStr = 'false') {
  if (!pattern) return;
  const pat    = makePat(pattern) ?? { test: s => s.includes(pattern) };
  const reload = reloadStr === 'true';
  let removed  = false;
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0].trim();
    if (!pat.test(name)) continue;
    const base = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    document.cookie = base;
    document.cookie = `${base}; domain=${location.hostname}`;
    document.cookie = `${base}; domain=.${location.hostname}`;
    removed = true;
  }
  if (removed && reload) location.reload();
}

const SNIPPETS = {
  'hide-if-contains':              hideIfContains,
  'hide-if-contains-visible-text': hideIfContainsVisibleText,
  'hide-if-has-and-matches-style': hideIfHasAndMatchesStyle,
  'hide-if-matches-xpath':         hideIfMatchesXPath,
  'abort-on-property-read':        abortOnPropertyRead,
  'abort-on-property-write':       abortOnPropertyWrite,
  'override-property-read':        overridePropertyRead,
  'abort-current-inline-script':   abortCurrentInlineScript,
  'event-override':                eventOverride,
  'prevent-listener':              preventListener,
  'blob-override':                 blobOverride,
  'replace-xhr-response':          replaceXhrResponse,
  'prevent-element-src-loading':   preventElementSrcLoading,
  'json-prune':                    jsonPrune,
  'cookie-remover':                cookieRemover,
};

// only DOM snippets re-run on mutations; others self-sustain via global patches
const DOM_SNIPPETS = new Set([
  'hide-if-contains',
  'hide-if-contains-visible-text',
  'hide-if-has-and-matches-style',
  'hide-if-matches-xpath',
]);

function runRule(rule, roots) {
  const [name, ...args] = rule;
  const fn = SNIPPETS[name];
  if (!fn) return; // unsupported snippet — skip silently
  try {
    if (roots == null) {
      fn(name, ...args);
      return;
    }
    switch (name) {
      case 'hide-if-contains':
      case 'hide-if-contains-visible-text': {
        const [text, selector, hidingSelector] = args;
        fn(name, text, selector, hidingSelector, roots);
        break;
      }
      case 'hide-if-has-and-matches-style': {
        const [search, selector, pseudo, property, value] = args;
        fn(name, search, selector, pseudo, property, value, roots);
        break;
      }
      case 'hide-if-matches-xpath': {
        const [xpath] = args;
        fn(name, xpath, roots);
        break;
      }
      default:
        fn(name, ...args);
    }
  } catch (_) {}
}

let domRules     = [];
let domTimer     = null;
let pendingRoots = [];

const snippetObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 1) pendingRoots.push(node);
    }
  }
  clearTimeout(domTimer);
  domTimer = setTimeout(() => {
    const roots = pendingRoots.filter(n => n.isConnected);
    pendingRoots = [];
    if (!roots.length) return;
    for (const rule of domRules) runRule(rule, roots);
  }, 50);
});

// CustomEvent is the only ISOLATED→MAIN channel; page scripts can also fire it (inherent MV3 constraint).
document.addEventListener('admask:snippets', (event) => {
  const allRules = event.detail?.rules ?? [];
  if (!allRules.length) return;

  console.debug('[AdMask] content-main.js: running', allRules.length, 'snippet rules');

  domRules = allRules.filter(r => DOM_SNIPPETS.has(r[0]));
  const onceRules = allRules.filter(r => !DOM_SNIPPETS.has(r[0]));

  for (const rule of onceRules) runRule(rule);

  // start observer before first pass so elements inserted during runRule are caught immediately
  if (domRules.length && document.body) {
    snippetObserver.observe(document.body, { childList: true, subtree: true });
  }

  for (const rule of domRules) runRule(rule);
});
})();
