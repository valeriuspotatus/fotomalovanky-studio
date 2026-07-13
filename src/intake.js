import { assessPhotoFile } from './inputQcFiles.js';
import { assessCount, nearDuplicatePairs, worstVerdict, DEFAULT_INTAKE } from './inputQc.js';
import { pickEmailCase } from './emailDrafts.js';

// Order-level input QC: decode every photo, gather the per-photo findings, add the cross-photo ones
// (exact + near duplicates, count vs expected), and roll up one verdict. That verdict gates the
// run — `hold` means the orchestrator skips the order and writes the email draft; `warn`/`info`
// proceed with the findings recorded. Decoding is injected (`assess`) so this order-level logic is
// unit-testable without an image library, the same pure/adapter split as qc.js and qcFiles.js.

const round = (n, dp = 2) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(dp)) : n);
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// The numeric evidence to carry alongside each per-photo finding, so the report and the review grid
// can say "blurry (var 42)" without re-measuring.
const VALUE_KEYS = {
  resolution: (a) => ({ mp: round(a.mp), shortSide: a.shortSide }),
  blur: (a) => ({ variance: round(a.variance) }),
  exposure: (a) => ({ mean: round(a.mean), clip: round(a.clip, 3) }),
};

/** Assess one order's input photos.
 *  @param {{ order:object, config?:object, expected?:?number, assess?:Function }} args
 *  @returns {Promise<{ expected:?number, uploaded:number, unique:number, verdict:string,
 *    emailCase:?string, findings:object[] }>} */
export async function assessIntake({ order, config = {}, expected = null, assess = assessPhotoFile }) {
  const opts = { ...DEFAULT_INTAKE, ...(config.intake ?? {}) };
  const photos = order?.photos ?? [];
  const perPhoto = await Promise.all(photos.map((p) => assess(p, opts)));

  const findings = [];

  // Per-photo: surface every non-ok resolution / blur / exposure verdict.
  for (const ph of perPhoto) {
    for (const check of ['resolution', 'blur', 'exposure']) {
      const a = ph[check];
      if (a && a.verdict !== 'ok') {
        findings.push({ check, base: ph.base, verdict: a.verdict, reason: a.reason, ...(VALUE_KEYS[check]?.(a) ?? {}) });
      }
    }
  }

  // Exact duplicates: identical bytes mean a distinct photo is genuinely missing. Hold.
  const bySha = new Map();
  for (const ph of perPhoto) {
    if (!ph.sha1) continue;
    if (!bySha.has(ph.sha1)) bySha.set(ph.sha1, []);
    bySha.get(ph.sha1).push(ph);
  }
  const exactPairs = new Set();
  let exactDupExtras = 0;
  for (const group of bySha.values()) {
    if (group.length < 2) continue;
    exactDupExtras += group.length - 1;
    findings.push({ check: 'duplicate', verdict: 'hold', reason: 'duplicate-identical', bases: group.map((p) => p.base) });
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) exactPairs.add(pairKey(group[i].base, group[j].base));
    }
  }

  // Near duplicates: the same shot, a different file. A warn the operator confirms — a burst of the
  // same child is legitimately similar. Skip any pair already caught as an exact duplicate.
  const readable = perPhoto.filter((p) => p.readable);
  for (const [i, j] of nearDuplicatePairs(readable.map((p) => p.hash), opts)) {
    const a = readable[i].base;
    const b = readable[j].base;
    if (!exactPairs.has(pairKey(a, b))) {
      findings.push({ check: 'duplicate', verdict: 'warn', reason: 'possible-duplicate', bases: [a, b] });
    }
  }

  // Count vs expected, on distinct photos.
  const uploaded = perPhoto.length;
  const unique = uploaded - exactDupExtras;
  const countAssess = assessCount({ expected, unique });
  if (countAssess.verdict !== 'ok') {
    findings.push({
      check: 'count',
      verdict: countAssess.verdict,
      reason: countAssess.reason,
      expected: countAssess.expected,
      uploaded,
      unique,
      missing: expected != null ? Math.max(0, expected - unique) : null,
    });
  }

  const verdict = worstVerdict(findings.map((f) => f.verdict));
  return { expected, uploaded, unique, verdict, emailCase: pickEmailCase(findings), findings };
}

/** Human text for one finding — for the run log, the grid and the held-order summary. Czech, to match
 *  the client-side FINDING map in index.html (the whole operator UI is Czech). */
export function describeFinding(f) {
  switch (f.reason) {
    case 'missing-photos': return `jen ${f.unique} z ${f.expected} fotek — ${f.missing} chybí`;
    case 'extra-photos': return `${f.uploaded} fotek, víc než ${f.expected} v produktu`;
    case 'duplicate-identical': return `stejná fotka je nahraná víckrát (${(f.bases ?? []).join(', ')})`;
    case 'possible-duplicate': return `dvě fotky vypadají jako stejný záběr (${(f.bases ?? []).join(', ')})`;
    case 'unreadable': return `${f.base} nejde otevřít`;
    case 'low-resolution': return `${f.base} je moc malá na tisk (${f.mp} MP)`;
    case 'smallish': return `${f.base} je spíš menší (${f.mp} MP)`;
    case 'blurry': return `${f.base} vypadá rozmazaně`;
    case 'dark': return `${f.base} je hodně tmavá`;
    case 'overexposed': return `${f.base} je hodně světlá`;
    case 'clipped': return `${f.base} má ztracené detaily ve světlech nebo stínech`;
    default: return `${f.base ?? ''} ${f.reason}`.trim();
  }
}

/** One operator-facing line for a held order. */
export function intakeSummary(result) {
  const count = result.findings.find((f) => f.check === 'count' && f.verdict === 'hold');
  if (count) return `jen ${result.unique} z ${result.expected} fotek — čeká na vás`;
  const holds = result.findings.filter((f) => f.verdict === 'hold');
  return `${[...new Set(holds.map(describeFinding))].join('; ')} — čeká na vás`;
}
