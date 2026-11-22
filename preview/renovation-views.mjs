const phases = ['existing', 'demolition', 'proposed'];
const comparisons = { before: 'existing', removals: 'demolition' };

// Older review links used the same condition for a physical model and a draft sheet.
export function renovationView(params, hasDrawings = true) {
  const legacy = params.get('condition');
  let drawing = params.get('drawings');
  let compare = params.get('compare');
  if (!drawing && !compare && phases.includes(legacy)) {
    if (params.get('view') === 'plan' && !params.get('scope')?.startsWith('wall/') && hasDrawings) drawing = legacy;
    else if (legacy !== 'proposed') compare = legacy === 'existing' ? 'before' : 'removals';
  }
  if (hasDrawings && phases.includes(drawing)) return { drawing, compare: null, condition: drawing };
  if (Object.hasOwn(comparisons, compare)) return { drawing: null, compare, condition: comparisons[compare] };
  return { drawing: null, compare: null, condition: 'design' };
}

export function writeRenovationView(params, { drawing, compare } = {}) {
  params.delete('condition');
  if (!drawing) params.delete('sheetLayout');
  if (drawing) params.set('drawings', drawing); else params.delete('drawings');
  if (!drawing && compare) params.set('compare', compare); else params.delete('compare');
}
