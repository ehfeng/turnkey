import { dimensions, units, normalizeCatalogDraft } from '../shared/catalog.mjs';
import { catalogRequest, getCatalogRecord } from './catalog-runtime.mjs';

function tag(name, text) {
  const node = document.createElement(name);
  if (text) node.textContent = text;
  return node;
}
function button(label) {
  const node = tag('button', label);
  node.type = 'button';
  return node;
}
function choices(values) {
  const node = tag('select');
  for (const [value, label] of values) node.add(new Option(label, value));
  return node;
}
function field(container, label, control) {
  const wrapper = tag('label', label);
  wrapper.className = 'editor-field';
  wrapper.append(control);
  container.append(wrapper);
  return control;
}
function input(type = 'text') {
  const node = tag('input');
  node.type = type;
  return node;
}
async function encodeFile(file) {
  if (file.size > 768 * 1024) throw new Error('The GLB must fit within 768 KiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}

// Catalog approval only publishes to the project library. Selecting or placing
// instances and saving the design remain explicit editor actions.
export function setupCatalogImport({ container, getHeaders = () => ({}), onApproved = () => {} }) {
  const panel = tag('details');
  const summary = tag('summary', 'Import furniture');
  panel.append(summary);
  const fields = tag('fieldset');
  fields.style.minWidth = '0';
  panel.append(fields);
  const previous = choices([['', 'New furniture']]);
  field(fields, 'Start from', previous);
  const url = field(fields, 'Product URL', input('url'));
  const sourceText = field(fields, 'Product specifications', tag('textarea'));
  const extract = button('Extract with AI');
  fields.append(extract);
  const name = field(fields, 'Furniture name', input());
  const variant = field(fields, 'Variant or finish', input());
  const measures = {};
  for (const key of dimensions) {
    const group = tag('div');
    group.className = 'editor-field';
    fields.append(group);
    const number = input('number');
    number.step = 'any'; number.min = '0';
    const unit = choices(units.map(unit => [unit, unit]));
    const evidence = input();
    field(group, key.charAt(0).toUpperCase() + key.slice(1), number);
    field(group, key + ' units', unit);
    field(group, key + ' source quotation', evidence);
    measures[key] = { number, unit, evidence };
  }
  const front = field(fields, 'Front of furniture', input());
  const anchor = field(fields, 'Anchor at underside', choices([['centre', 'Footprint centre'], ['rear-centre', 'Rear centre']]));
  const notes = field(fields, 'Estimates or unresolved details', tag('textarea'));
  const footprint = tag('figure');
  const box = tag('div');
  box.style.cssText = 'border:1px solid currentColor;background:#e8efea;color:#244c40;text-align:center;font-size:.8rem;display:grid;align-items:start;min-height:1.2rem;';
  box.textContent = '↑ Front';
  const caption = tag('figcaption');
  footprint.append(box, caption);
  fields.append(footprint);
  const modelFile = field(fields, 'Optional self-contained GLB (up to 768 KiB)', input('file'));
  modelFile.accept = '.glb,model/gltf-binary';
  const modelFront = field(fields, 'GLB front axis', choices(['+Z', '-Z', '+X', '-X'].map(axis => [axis, axis])));
  const approve = button('Approve catalog asset');
  fields.append(approve);
  const status = tag('p');
  status.setAttribute('role', 'status');
  panel.append(status);
  container.append(panel);

  let parentRevision = null, previousModel = null, action = 0;
  function draft() {
    const measurements = {};
    for (const [key, { number, unit, evidence }] of Object.entries(measures)) measurements[key] =
      { value: number.valueAsNumber, unit: unit.value, evidence: evidence.value };
    return { name: name.value, variant: variant.value, measurements, front: front.value, anchor: anchor.value, notes: notes.value,
      source: { url: url.value, text: sourceText.value } };
  }
  function preview() {
    const data = draft();
    try {
      const { entry } = normalizeCatalogDraft({ ...data, name: data.name || 'Preview', front: data.front || 'Front', source: { text: 'Review' } });
      const max = Math.max(entry.size_x_mm, entry.size_y_mm);
      box.style.width = (120 * entry.size_x_mm / max) + 'px';
      box.style.height = (120 * entry.size_y_mm / max) + 'px';
      caption.textContent = entry.size_x_mm + ' × ' + entry.size_y_mm + ' mm footprint · ' + entry.anchor;
      footprint.hidden = false;
    } catch { footprint.hidden = true; }
  }
  function fill(data = {}) {
    name.value = data.name ?? ''; variant.value = data.variant ?? '';
    front.value = data.front || ''; anchor.value = data.anchor === 'rear-centre' ? 'rear-centre' : 'centre';
    notes.value = data.notes ?? '';
    for (const [key, { number, unit, evidence }] of Object.entries(measures)) {
      const dimension = data.measurements?.[key];
      number.value = typeof dimension?.value === 'number' ? String(dimension.value) : '';
      unit.value = units.includes(dimension?.unit) ? dimension.unit : 'mm';
      evidence.value = dimension?.evidence ?? '';
    }
    preview();
  }

  const post = async (path, body) => {
    const headers = new Headers(await getHeaders());
    headers.set('Content-Type', 'application/json');
    return catalogRequest(path, { method: 'POST', headers, body: JSON.stringify(body) });
  };
  async function refresh() {
    const { revisions } = await catalogRequest();
    previous.replaceChildren(new Option('New furniture', ''), ...revisions.map(row =>
      new Option(row.entry.name + (row.variant ? ' · ' + row.variant : '') + ' · ' + row.id.slice(-8), row.id)));
    previous.value = parentRevision || '';
  }
  async function guarded(work) {
    const current = ++action;
    fields.disabled = true;
    try { await work(); }
    catch (error) { status.textContent = error.message; }
    finally { if (current === action) fields.disabled = false; }
  }

  fields.addEventListener('input', preview);
  panel.addEventListener('toggle', () => { if (panel.open) void guarded(refresh); });
  previous.addEventListener('change', () => void guarded(async () => {
    const id = previous.value;
    const record = id ? await getCatalogRecord(id) : null;
    parentRevision = id || null; previousModel = record?.model ?? null;
    modelFile.value = ''; modelFront.value = previousModel?.front ?? '+Z';
    url.value = record?.source.url ?? ''; sourceText.value = record?.source.text ?? '';
    fill(record ? { ...record, name: record.entry.name } : undefined);
    status.textContent = record ? 'Changes will publish a new revision of this catalog asset.' : '';
  }));
  extract.addEventListener('click', () => void guarded(async () => {
    status.textContent = 'Reading product specifications…';
    const result = await post('/extract', { source: draft().source });
    fill(result.draft);
    status.textContent = 'Review the dimensions, sources, front and anchor before approving.';
  }));
  approve.addEventListener('click', () => void guarded(async () => {
    const reviewed = draft();
    normalizeCatalogDraft(reviewed);
    const file = modelFile.files?.[0];
    const base64 = file ? await encodeFile(file) : previousModel?.base64;
    if (base64) reviewed.model = { format: 'glb', front: modelFront.value, base64 };
    const { revision } = await post('/approve', { draft: reviewed, parentRevision });
    parentRevision = revision.id;
    previousModel = reviewed.model ?? null;
    modelFile.value = '';
    await onApproved(revision.id);
    await refresh();
    status.textContent = 'Approved ' + revision.entry.name + '. It is available to place.';
  }));
  preview();
  return panel;
}
