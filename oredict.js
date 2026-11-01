// Oredict card strings: a faithful port of AE2 (GTNH) OreFilteredList, plus a generator
// that builds a short string matching a chosen group of items.
//
// Card rules (appeng.util.prioitylist.OreFilteredList):
// - If the string contains any of \ ^ $ + ( ) [ ], the whole string is one Java regex, and an
//   item matches when the regex is found in any of its ore names.
// - Otherwise it is split into operands on & and |, combined strictly left to right (no
//   precedence). An operand starting with ! is negated at the item level, i.e. "no ore name
//   matches". Each operand matches an ore name by: all stars -> anything; *x* -> contains;
//   *x -> endsWith; x* -> startsWith; no star -> equals; any other star layout -> ^regex$
//   with * as .*.
const Oredict = (() => {
  const REGEX_CHARS = /[\\^$+()[\]]/;
  // characters an exact ore name cannot carry into a wildcard-mode string
  const UNSAFE = /[\\^$+()[\]&|*]/g;
  const UNSAFE_T = /[\\^$+()[\]&|*]/;

  // scoring surcharge so a wildcard has to save a few characters before it beats an exact name
  const WILD_COST = 4;

  function notAWildcard(f) { return REGEX_CHARS.test(f); }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Java's String.trim(): strips chars <= U+0020
  function jtrim(s) { return s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ''); }

  function namePredicate(filter) {
    const stars = (filter.match(/\*/g) || []).length;
    if (stars === filter.length) return () => true;
    if (filter.length > 2 && filter[0] === '*' && filter.endsWith('*') && stars === 2) {
      const p = filter.slice(1, -1); return s => s.includes(p);
    }
    if (filter.length >= 2 && filter[0] === '*' && stars === 1) {
      const p = filter.slice(1); return s => s.endsWith(p);
    }
    if (filter.length >= 2 && filter.endsWith('*') && stars === 1) {
      const p = filter.slice(0, -1); return s => s.startsWith(p);
    }
    if (stars === 0) return s => s === filter;
    // Java builds "^" + filter.replace("*", ".*") + "$", so other regex chars in it stay live
    const re = new RegExp('^' + filter.replace(/\*/g, '.*') + '$');
    return s => re.test(s);
  }

  // Java regex differs from JS in places; this covers what people type into the card.
  function javaRegex(src) {
    return new RegExp(src.replace(/\(\?<([A-Za-z][A-Za-z0-9]*)>/g, '(?<$1>'), 'u');
  }

  class Index {
    constructor(data) {
      this.names = data.names;
      this.items = data.items;
      this.itemNames = data.items.map(it => it[2]);
      const nameItems = this.names.map(() => []);
      this.itemNames.forEach((ns, i) => { for (const n of ns) nameItems[n].push(i); });
      this.nameItems = nameItems;
      // reversed-name index for *suffix lookups
      this.revOrder = this.names.map((n, i) => [[...n].reverse().join(''), i])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      this.revKeys = this.revOrder.map(r => r[0]);
      this.namesSorted = this.names.every((n, i) => i === 0 || this.names[i - 1] < n);
      this.memo = new Map();
    }

    // indices of ore names matched by one wildcard-mode operand (without the !)
    matchNames(filter) {
      let r = this.memo.get(filter);
      if (!r) {
        if (this.memo.size > 20000) this.memo.clear();
        this.memo.set(filter, (r = this.matchNamesRaw(filter)));
      }
      return r;
    }

    matchNamesRaw(filter) {
      const stars = (filter.match(/\*/g) || []).length;
      const n = this.names;
      if (stars === 0) {
        const i = this.namesSorted ? bsearch(n, filter) : n.indexOf(filter);
        return i >= 0 && n[i] === filter ? [i] : [];
      }
      if (this.namesSorted && filter.length >= 2 && stars === 1 && filter.endsWith('*')) {
        return prefixRange(n, filter.slice(0, -1)).map((_, k, a) => a.lo + k);
      }
      if (filter.length >= 2 && stars === 1 && filter[0] === '*') {
        const r = prefixRange(this.revKeys, [...filter.slice(1)].reverse().join(''));
        return r.map((_, k) => this.revOrder[r.lo + k][1]);
      }
      const p = namePredicate(filter), out = [];
      for (let i = 0; i < n.length; i++) if (p(n[i])) out.push(i);
      return out;
    }

    // Uint8Array over items: 1 if the item is matched by the card string
    evaluate(str) {
      const f = jtrim(str);
      const out = new Uint8Array(this.items.length);
      if (!f) return { set: out, mode: 'empty' };
      if (notAWildcard(f)) {
        const re = javaRegex(f);
        const hit = this.names.map(s => re.test(s));
        this.itemNames.forEach((ns, i) => { if (ns.some(k => hit[k])) out[i] = 1; });
        return { set: out, mode: 'regex' };
      }
      const re = /[^&|]+/g;
      let m, endLast = 0, first = true;
      while ((m = re.exec(f))) {
        let filter = jtrim(m[0]);
        if (!filter) continue;
        const neg = filter[0] === '!';
        if (neg) filter = filter.slice(1);
        const t = new Uint8Array(out.length);
        for (const k of this.matchNames(filter)) for (const i of this.nameItems[k]) t[i] = 1;
        if (neg) for (let i = 0; i < t.length; i++) t[i] ^= 1;
        const or = f.slice(endLast, m.index).includes('|');
        if (first) out.set(t);
        else if (or) for (let i = 0; i < out.length; i++) out[i] |= t[i];
        else for (let i = 0; i < out.length; i++) out[i] &= t[i];
        first = false;
        endLast = m.index + m[0].length;
      }
      return { set: out, mode: 'wildcard' };
    }

    // items with exactly the same ore names cannot be told apart by any card string
    twins(i) {
      const key = this.itemNames[i].join(',');
      const ns = this.itemNames[i];
      if (!ns.length) return [i];
      return this.nameItems[ns[0]].filter(j => this.itemNames[j].join(',') === key);
    }
  }

  function bsearch(a, x) {
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // the slice of sorted array a whose entries start with p, as an array-like with .lo
  function prefixRange(a, p) {
    const lo = bsearch(a, p);
    let hi = lo;
    while (hi < a.length && a[hi].startsWith(p)) hi++;
    const r = new Array(hi - lo).fill(0);
    r.lo = lo;
    return r;
  }

  // camelCase / digit / punctuation boundaries: "plateQuadrupleMithril" -> plate|Quadruple|Mithril
  function tokens(name) {
    return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+|[^A-Za-z0-9]+/g) || [name];
  }

  // a wildcard-mode term that matches this ore name (and maybe more)
  function safeExact(name) {
    let t = name.replace(UNSAFE, '*').replace(/\*+/g, '*');
    if (t.startsWith('!')) t = '*' + t.slice(1);
    if (jtrim(t) !== t) t = jtrim(t);
    return t || null;
  }

  // candidate terms that each match `name`: the name itself, then camelCase prefixes,
  // suffixes and interior substrings
  function termsFor(name, wild) {
    const exact = safeExact(name);
    const out = exact ? [exact] : [];
    if (!wild || exact !== name) return out;
    const tk = tokens(name);
    for (let i = 1; i < tk.length; i++) {
      const pre = tk.slice(0, i).join(''), suf = tk.slice(i).join('');
      if (!UNSAFE_T.test(pre) && pre.length >= 2) out.push(pre + '*');
      if (!UNSAFE_T.test(suf) && suf.length >= 3) out.push('*' + suf);
    }
    for (let i = 1; i < tk.length - 1; i++) {
      for (let j = i + 1; j < tk.length; j++) {
        const mid = tk.slice(i, j).join('');
          if (mid.length >= 3 && !UNSAFE_T.test(mid) && !mid.startsWith('!')) out.push('*' + mid + '*');
      }
    }
    return out.filter(t => jtrim(t) === t && t[0] !== '!');
  }

  // Build a card string for the target items.
  // opts.wild: allow wildcards (default true)
  // opts.deny: items that must not match
  // opts.loose: only denied items must stay out; anything else may match too
  // Returns { string, positives, negatives, matched (Uint8Array), missing, extras, twins }
  function generate(index, targetList, opts = {}) {
    const wild = opts.wild !== false;
    const N = index.items.length;
    const inT = new Uint8Array(N);
    for (const i of targetList) inT[i] = 1;
    const inD = new Uint8Array(N);
    for (const i of opts.deny || []) if (!inT[i]) inD[i] = 1;
    // pull in indistinguishable items: a string can never separate them. A denied twin stays
    // denied and is reported as an extra that cannot be excluded.
    const twins = [];
    for (const i of targetList) for (const j of index.twins(i)) if (!inT[j] && !inD[j]) { inT[j] = 1; twins.push(j); }
    // items the string must keep out
    const bad = new Uint8Array(N);
    for (let i = 0; i < N; i++) bad[i] = !inT[i] && (opts.loose ? inD[i] : 1);
    const T = [];
    for (let i = 0; i < N; i++) if (inT[i] && index.itemNames[i].length) T.push(i);
    if (!T.length) return emptyResult(N, twins);

    const inTN = new Uint8Array(index.names.length);
    for (const i of T) for (const n of index.itemNames[i]) inTN[n] = 1;

    const termCache = new Map();
    const evalTerm = term => {
      let c = termCache.get(term);
      if (c) return c;
      const names = index.matchNames(term);
      const seen = new Set(), cover = [], extra = [];
      for (const n of names) for (const i of index.nameItems[n]) {
        if (seen.has(i)) continue;
        seen.add(i);
        (inT[i] ? cover : extra).push(i);
      }
      c = { term, names, cover, extra, clean: names.every(n => !inTN[n]) };
      termCache.set(term, c);
      return c;
    };

    // positive candidates from every ore name the group carries
    const posTerms = new Set();
    for (let n = 0; n < inTN.length; n++) if (inTN[n]) for (const t of termsFor(index.names[n], wild)) posTerms.add(t);
    // contains-scans are linear in the name count; keep big groups snappy
    const cands = [...posTerms].filter(t => !(t.startsWith('*') && t.endsWith('*')) || posTerms.size < 6000)
      .map(evalTerm).filter(c => c.cover.length);

    // an extra can be excluded iff it has an ore name the group lacks
    const excludable = new Uint8Array(N);
    for (const c of cands) for (const x of c.extra) if (bad[x]) excludable[x] = index.itemNames[x].some(n => !inTN[n]) ? 1 : 2;

    let best = null;
    const seenStrings = new Map();
    for (const lambda of [0.5, 2, 5, 12, 40, 1e6]) {
      const r = attempt(lambda);
      if (!best || r.unresolved < best.unresolved || (r.unresolved === best.unresolved && r.string.length < best.string.length)) best = r;
    }
    return best;

    function attempt(lambda) {
      const covered = new Uint8Array(N), extraSet = new Uint8Array(N);
      let left = T.length;
      const chosen = [];
      while (left > 0) {
        let bc = null, bs = -1;
        for (const c of cands) {
          let gain = 0;
          for (const i of c.cover) if (!covered[i]) gain++;
          if (!gain) continue;
          let pen = 0;
          for (const x of c.extra) if (bad[x] && !extraSet[x]) pen += excludable[x] === 1 ? lambda : 1e4;
          const s = gain / (c.term.length + 1 + (c.term.includes('*') ? WILD_COST : 0) + pen);
          if (s > bs) { bs = s; bc = c; }
        }
        if (!bc) break;
        chosen.push(bc);
        for (const i of bc.cover) if (!covered[i]) { covered[i] = 1; left--; }
        for (const x of bc.extra) extraSet[x] = 1;
      }
      // drop positives made redundant by later picks
      const pos = prunePositives(chosen);
      const X = new Set();
      for (const c of pos) for (const x of c.extra) if (bad[x]) X.add(x);
      const negs = pickNegatives([...X]);
      const string = pos.map(c => c.term).join('|') + negs.map(c => '&!' + c.term).join('');
      if (seenStrings.has(string)) return seenStrings.get(string);
      const matched = index.evaluate(string).set;
      const missing = [], extras = [];
      for (let i = 0; i < N; i++) {
        if (inT[i] && !matched[i]) missing.push(i);
        else if (bad[i] && matched[i]) extras.push(i);
      }
      const res = { string, positives: pos.map(c => c.term), negatives: negs.map(c => c.term), matched, missing, extras, twins, unresolved: missing.length * 1000 + extras.length };
      seenStrings.set(string, res);
      return res;
    }

    function prunePositives(chosen) {
      const count = new Uint16Array(N);
      for (const c of chosen) for (const i of c.cover) count[i]++;
      const keep = [];
      for (const c of [...chosen].sort((a, b) => b.extra.length - a.extra.length || b.term.length - a.term.length)) {
        if (c.cover.every(i => count[i] > 1)) { for (const i of c.cover) count[i]--; continue; }
        keep.push(c);
      }
      return chosen.filter(c => keep.includes(c));
    }

    // greedy set cover of the extras with exclusions that touch no ore name in the group
    function pickNegatives(X) {
      if (!X.length) return [];
      const negTerms = new Set();
      for (const x of X) for (const n of index.itemNames[x]) if (!inTN[n]) for (const t of termsFor(index.names[n], wild)) negTerms.add(t);
      const negs = [...negTerms].map(evalTerm).filter(c => c.clean);
      const need = new Set(X.filter(x => excludable[x] !== 2 && index.itemNames[x].some(n => !inTN[n])));
      const out = [];
      while (need.size) {
        let bc = null, bs = -1;
        for (const c of negs) {
          let gain = 0;
          for (const i of c.extra) if (need.has(i)) gain++;
          const s = gain / (c.term.length + 2 + (c.term.includes('*') ? WILD_COST : 0));
          if (gain && s > bs) { bs = s; bc = c; }
        }
        if (!bc) break;
        out.push(bc);
        for (const i of bc.extra) need.delete(i);
      }
      // drop exclusions whose items are all excluded by others
      const Xs = new Set(X);
      return out.filter((c, k) => {
        const others = out.filter((d, j) => j !== k && !d.dropped);
        const mine = c.extra.filter(i => Xs.has(i));
        const redundant = mine.every(i => others.some(d => d.extra.includes(i)));
        if (redundant) c.dropped = true;
        return !redundant;
      }).map(c => { delete c.dropped; return c; });
    }
  }

  function emptyResult(N, twins) {
    return { string: '', positives: [], negatives: [], matched: new Uint8Array(N), missing: [], extras: [], twins, unresolved: 0 };
  }

  return { Index, generate, namePredicate, notAWildcard, tokens, termsFor, escapeRe };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Oredict;
