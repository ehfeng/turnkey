const states = {
  merged: 'Merged into the house',
  open: 'Open proposal',
  current: 'Viewing this branch',
};
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function shortRevision(revision) {
  return revision.slice(0, 7);
}

function revisionGraph(entry, baseDesign, goTo) {
  const points = [];
  const recordedBranch = entry.status !== 'merged' ||
    (entry.branch && entry.branch !== 'main' && !['direct', 'squash'].includes(entry.integration));
  const start = recordedBranch ? entry.baseRevision : entry.parentRevision;
  if (start && start !== entry.revision) {
    points.push([recordedBranch ? 'Started from' : 'Previous main', start, 'base']);
  }
  points.push([recordedBranch ? 'Branch revision' : 'Main revision', recordedBranch ? entry.revision : (entry.mergedRevision || entry.revision), recordedBranch ? 'tip' : 'main']);
  if (recordedBranch && entry.status === 'merged' && entry.mergedRevision && entry.mergedRevision !== entry.revision) {
    points.push(['Merged as', entry.mergedRevision, 'merge']);
  }

  const graph = element('div', 'history-graph');
  // Each lane describes this branch only. A curated list may skip many other commits.
  const rail = element('div', 'history-rail');
  rail.setAttribute('aria-hidden', 'true');
  const labels = element('div', 'history-nodes');
  labels.style.gridTemplateColumns = `repeat(${points.length}, minmax(0, 1fr))`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 120 32');
  svg.setAttribute('preserveAspectRatio', 'none');
  rail.append(svg);

  function line(d, kind) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', kind);
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(path);
  }

  const positions = points.map(([, , role], i) => ({
    x: (i + .5) * 120 / points.length,
    y: role === 'tip' ? 24 : 9,
  }));
  if (points.length === 3) {
    line(`M ${positions[0].x} 9 H ${positions[2].x}`, 'house-line');
  }
  for (let i = 1; i < positions.length; i++) {
    const start = positions[i - 1];
    const end = positions[i];
    const middle = (start.x + end.x) / 2;
    line(`M ${start.x} ${start.y} C ${middle} ${start.y} ${middle} ${end.y} ${end.x} ${end.y}`, recordedBranch ? 'proposal-line' : 'house-line');
  }
  points.forEach(([label, revision, role], i) => {
    const dot = element('span', `history-dot ${role}`);
    dot.style.left = `${positions[i].x / 120 * 100}%`;
    dot.style.top = `${positions[i].y}px`;
    rail.append(dot);
    const point = element('div');
    const commit = element('code', '', shortRevision(revision));
    commit.title = revision;
    point.append(element('span', '', label), commit);
    if (role === 'base' && baseDesign) {
      const link = element('a', 'history-source', baseDesign.title);
      link.href = `#${baseDesign.anchor}`;
      link.addEventListener('click', event => {
        event.preventDefault();
        goTo(baseDesign);
      });
      point.append(link);
    }
    labels.append(point);
  });
  graph.append(rail, labels);
  return graph;
}

function linkTo(label, href) {
  if (typeof href !== 'string' || !href.trim()) return null;
  try {
    const url = new URL(href, document.baseURI);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const link = element('a', '', label);
    link.href = url.href;
    return link;
  } catch { return null; }
}

function scopeLabel(scope) {
  if (scope === 'house') return 'Whole house';
  if (!scope) return 'Unspecified area';
  const name = String(scope).split('/').at(-1).replaceAll('-', ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function prepareEntries(entries) {
  const revisions = new Map();
  const designs = entries.map((entry, index) => {
    const changes = entry.changes?.length ? entry.changes : [
      { scope: entry.scope ?? '', label: scopeLabel(entry.scope), summary: entry.title },
    ];
    const design = { ...entry, changes, anchor: `history-entry-${index + 1}` };
    for (const revision of new Set([entry.revision, entry.mergedRevision])) {
      if (!revision) continue;
      if (!revisions.has(revision)) revisions.set(revision, []);
      revisions.get(revision).push(design);
    }
    return design;
  });
  for (const design of designs) {
    const parents = (revisions.get(design.baseRevision || design.parentRevision) ?? []).filter(other => other !== design);
    if (parents.length === 1) design.baseDesign = parents[0];
  }
  return designs.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
}

const integrationLabels = {
  direct: 'Direct commit to main',
  squash: 'Squash commit on main',
  merge: 'Merge commit on main',
};

function renderEntry(entry, changes, goTo) {
  const item = element('li', 'history-entry');
  item.dataset.status = entry.status;
  const summary = element('div', 'history-summary');
  const text = element('div', 'history-changes');
  const title = entry.title.trim();
  const hasHeadline = title && !/^(?:merge (?:branch|pull request|remote-tracking branch)\b|fixup!|squash!|wip$)/i.test(title) &&
    !changes.some(change => change.summary.trim().toLowerCase() === title.toLowerCase());
  changes.forEach((change, index) => {
    const heading = element('h4', '', change.label);
    if (index === 0) {
      heading.id = entry.anchor;
      heading.tabIndex = -1;
    }
    text.append(heading);
    if (index === 0 && hasHeadline) text.append(element('p', 'history-headline', title));
    text.append(element('p', 'history-description', change.summary));
  });
  summary.append(text);
  const thumbnailUrl = linkTo('', entry.thumbnail)?.href;
  if (thumbnailUrl && new URL(thumbnailUrl).origin === location.origin) {
    const thumbnail = element('img', 'history-thumbnail');
    thumbnail.src = thumbnailUrl;
    thumbnail.alt = '';
    thumbnail.loading = 'lazy';
    thumbnail.decoding = 'async';
    thumbnail.addEventListener('error', () => thumbnail.remove(), { once: true });
    summary.append(thumbnail);
  }
  const meta = element('div', 'history-meta');
  if (entry.date && Number.isFinite(Date.parse(entry.date))) {
    const date = element('time', '', dateFormat.format(new Date(entry.date)));
    date.dateTime = entry.date;
    meta.append(date);
  }
  if (entry.status !== 'merged') meta.append(element('span', 'history-state', states[entry.status]));
  const preview = linkTo('Open preview', entry.links?.preview);
  const image = linkTo('View image', entry.links?.image);
  if (preview) meta.append(preview);
  if (image) meta.append(image);

  const detail = element('details', 'history-detail');
  detail.append(element('summary', '', 'Revision details'));
  const git = element('div', 'history-detail-body');
  const integration = integrationLabels[entry.integration] ?? states[entry.status];
  git.append(element('strong', 'history-commit-title', entry.title), element('span', '', integration));
  if (entry.branch) git.append(element('code', 'history-branch', entry.branch));
  git.append(revisionGraph(entry, entry.baseDesign, goTo));
  const review = linkTo('Review changes', entry.links?.review);
  if (review) git.append(review);
  if (!preview && !image) git.append(element('span', '', 'No saved preview'));
  detail.append(git);
  item.append(summary, meta, detail);
  return item;
}

function isValidEntry(entry) {
  return entry && Object.hasOwn(states, entry.status) &&
    typeof entry.title === 'string' && typeof entry.revision === 'string' &&
    [entry.branch, entry.scope, entry.baseRevision, entry.parentRevision, entry.mergedRevision]
      .every(value => value == null || typeof value === 'string') &&
    (!entry.changes || (Array.isArray(entry.changes) && entry.changes.every(change =>
      change && typeof change.scope === 'string' && typeof change.label === 'string' &&
      typeof change.summary === 'string')));
}

export function enableDesignHistory(source) {
  const trigger = document.querySelector('#open-history');
  const dialog = document.querySelector('#design-history');
  const close = document.querySelector('#close-history');
  const retry = document.querySelector('#retry-history');
  const status = document.querySelector('#history-status');
  const filter = document.querySelector('#history-filter');
  const area = document.querySelector('#history-area');
  const main = document.querySelector('#history-main');
  const proposals = document.querySelector('#history-proposals');
  const mainList = document.querySelector('#history-entries');
  const branchList = document.querySelector('#history-branch-entries');
  let loading = false;
  let designs;

  function updateUrl(open, areaId) {
    const url = new URL(location.href);
    if (open) url.searchParams.set('history', 'on');
    else url.searchParams.delete('history');
    if (areaId) url.searchParams.set('historyScope', areaId);
    else if (!open) url.searchParams.delete('historyScope');
    history.replaceState(history.state, '', url);
  }

  function goTo(design) {
    let heading = document.getElementById(design.anchor);
    if (!heading) {
      area.value = 'all';
      updateUrl(true, area.value);
      render();
      heading = document.getElementById(design.anchor);
    }
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'center' });
  }

  function render() {
    const house = [];
    const branches = [];
    for (const design of designs) {
      const changes = area.value === 'all' ? design.changes :
        design.changes.filter(change => change.scope === area.value);
      if (!changes.length) continue;
      (design.status === 'merged' ? house : branches).push(renderEntry(design, changes, goTo));
    }
    mainList.replaceChildren(...house);
    branchList.replaceChildren(...branches);
    main.hidden = !house.length;
    proposals.hidden = !branches.length;
    const count = house.length + branches.length;
    status.textContent = count ? '' : area.value === 'all'
      ? 'No design changes have been recorded yet.'
      : `No recorded changes for ${area.selectedOptions[0].textContent}.`;
    dialog.querySelector('.history-body').scrollTop = 0;
  }

  function setArea() {
    const params = new URL(location.href).searchParams;
    const scope = params.get('scope') || document.querySelector('#scope')?.value || '';
    const options = new Map();
    for (const design of designs) {
      for (const change of design.changes) {
        if (change.scope) options.set(change.scope, change.label);
      }
    }
    if (scope.startsWith('room/') && !options.has(scope)) options.set(scope, scopeLabel(scope));
    const selected = params.get('historyScope') ?? (scope.startsWith('room/') ? scope : 'all');
    area.replaceChildren(new Option('All house changes', 'all'));
    for (const [id, label] of [...options].sort((a, b) => a[1].localeCompare(b[1]))) {
      area.add(new Option(label, id));
    }
    area.value = options.has(selected) ? selected : 'all';
    filter.hidden = !options.size;
    render();
  }

  async function load() {
    if (designs) { setArea(); return; }
    if (loading) return;
    loading = true;
    retry.hidden = true;
    status.textContent = 'Loading design history…';
    try {
      const response = await fetch(source);
      if (!response.ok) throw new Error('History request failed');
      const { entries } = await response.json();
      if (!Array.isArray(entries) || !entries.every(isValidEntry)) throw new Error('Invalid history entries');
      designs = prepareEntries(entries);
      setArea();
    } catch {
      status.textContent = 'Design history could not be loaded.';
      retry.hidden = false;
    } finally {
      loading = false;
    }
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    updateUrl(true);
    void load();
  }

  function dismiss() {
    dialog.close();
    updateUrl(false);
    trigger.focus();
  }

  trigger.hidden = false;
  trigger.addEventListener('click', open);
  close.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    dismiss();
  });
  retry.addEventListener('click', load);
  area.addEventListener('change', () => {
    updateUrl(true, area.value);
    render();
  });
  window.addEventListener('popstate', () => {
    if (new URL(location.href).searchParams.get('history') === 'on') open();
    else if (dialog.open) dismiss();
  });
  if (new URL(location.href).searchParams.get('history') === 'on') open();
}
