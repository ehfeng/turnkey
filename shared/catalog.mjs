// Placed instances retain this identifier when an asset's dimensions or model change.
export function bundledAssetRevision(geometryRevision, assetPath) {
  if (typeof geometryRevision !== 'string' || !geometryRevision || !/^assets\/[^/]+\/model\/build\.mjs$/.test(assetPath)) {
    throw new Error('Expected a geometry revision and a bundled asset path.');
  }
  return 'bundle:' + encodeURIComponent(geometryRevision) + ':' + encodeURIComponent(assetPath);
}

export function classifyAssetRevision(id, geometryRevision) {
  if (typeof id !== 'string') return null;
  if (/^asset:[a-f0-9]{64}$/.test(id)) return { kind: 'imported' };
  const parts = id.split(':');
  try {
    if (parts.length === 3 && parts[0] === 'bundle') {
      const assetPath = decodeURIComponent(parts[2]);
      if (id === bundledAssetRevision(geometryRevision, assetPath)) return { kind: 'bundled', assetPath };
    }
  } catch { /* Invalid identifier or URI escaping. */ }
  return null;
}

export const dimensions = ['width', 'depth', 'height'];
const unitMm = new Map([['mm', 1], ['cm', 10], ['m', 1000], ['in', 25.4], ['ft', 304.8]]);
export const units = [...unitMm.keys()];

function textField(value, limit, label, required = false) {
  if (value == null) value = '';
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new Error('Check the ' + label + '.');
  }
  return value.trim();
}

export function catalogSource(input = {}) {
  const text = textField(input?.text, 32000, 'source text');
  const url = textField(input?.url, 2048, 'source URL');
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Enter a complete product URL.'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Enter a public HTTP or HTTPS product URL.');
  }
  if (!url && !text) throw new Error('Enter a product URL or paste the product specifications.');
  return { url, text };
}

// The approved copy preserves both the evidence in its original units and the
// numbers used by the placement engine. Unknown values can stay blank in drafts.
export function normalizeCatalogDraft(draft) {
  if (!draft || typeof draft !== 'object') throw new Error('Expected an asset to review.');
  const source = catalogSource(draft.source);
  const name = textField(draft.name, 180, 'product name', true);
  const variant = textField(draft.variant, 180, 'product variant');
  const anchor = draft.anchor ?? 'centre';
  if (!['centre', 'rear-centre'].includes(anchor)) throw new Error('Choose a placement anchor.');
  const front = textField(draft.front, 160, 'front description', true);
  const notes = textField(draft.notes, 2500, 'uncertainty notes');
  const measurements = {}, size = [];
  for (const key of dimensions) {
    const measure = draft.measurements?.[key];
    if (!unitMm.has(measure?.unit) || typeof measure.value !== 'number' || !Number.isFinite(measure.value) || measure.value <= 0) {
      throw new Error('Enter a positive ' + key + ' and choose its units.');
    }
    const mm = Math.round(measure.value * unitMm.get(measure.unit) * 1000) / 1000;
    if (!Number.isFinite(mm) || mm <= 0 || mm > 100000) throw new Error('Check the ' + key + ' measurement and units.');
    measurements[key] = { value: measure.value, unit: measure.unit, evidence: textField(measure.evidence, 1000, key + ' evidence') };
    size.push(mm);
  }
  return {
    schemaVersion: 1, source, variant, measurements, front, anchor, notes,
    entry: { name, size_x_mm: size[0], size_y_mm: size[1], size_z_mm: size[2],
      anchor: anchor === 'centre' ? 'Footprint centre at underside' : 'Rear centre at underside',
      offset_x_mm: 0, offset_y_mm: anchor === 'rear-centre' ? size[1] / 2 : 0 },
  };
}
