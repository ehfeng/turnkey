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

function revisionGraph(entry, baseHeading) {
  const points = [];
  if (entry.baseRevision && (baseHeading || entry.baseRevision !== entry.revision)) {
    points.push(['Started from', entry.baseRevision, 'base']);
  }
  points.push(['Branch revision', entry.revision, 'tip']);
  if (entry.status === 'merged' && entry.mergedRevision) {
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
    line(`M ${start.x} ${start.y} C ${middle} ${start.y} ${middle} ${end.y} ${end.x} ${end.y}`, 'proposal-line');
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
    if (role === 'base' && baseHeading) {
      const link = element('a', 'history-source', baseHeading.textContent);
      link.href = `#${baseHeading.id}`;
      link.addEventListener('click', event => {
        event.preventDefault();
        baseHeading.focus({ preventScroll: true });
        baseHeading.scrollIntoView({ block: 'center' });
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

function renderEntry(entry, title, baseHeading) {
  const item = element('li', 'history-entry');
  item.dataset.status = entry.status;
  const meta = element('div', 'history-meta');
  meta.append(element('span', 'history-state', states[entry.status]));
  if (entry.date && Number.isFinite(Date.parse(entry.date))) {
    const date = element('time', '', dateFormat.format(new Date(entry.date)));
    date.dateTime = entry.date;
    meta.append(date);
  }
  const info = element('p', 'history-branch');
  info.append(element('code', '', entry.branch));
  if (entry.scope) info.append(document.createTextNode(` · ${entry.scope}`));
  const actions = element('div', 'history-links');
  const preview = linkTo('Open preview', entry.links?.preview);
  const review = linkTo('Review changes', entry.links?.review);
  const image = linkTo('View image', entry.links?.image);
  if (preview) actions.append(preview);
  if (image) actions.append(image);
  if (!preview && !image) actions.append(element('span', '', 'No saved preview'));
  if (review) actions.append(review);
  const summary = element('div', 'history-summary');
  const heading = element('div');
  heading.append(title, info);
  summary.append(heading);
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
  item.append(meta, summary, revisionGraph(entry, baseHeading), actions);
  return item;
}

function renderEntries(entries) {
  const sources = new Map();
  const titles = entries.map((entry, index) => {
    const title = element('h3', '', entry.title);
    title.id = `history-entry-${index + 1}`;
    title.tabIndex = -1;
    for (const revision of new Set([entry.revision, entry.mergedRevision])) {
      if (!revision) continue;
      if (!sources.has(revision)) sources.set(revision, []);
      sources.get(revision).push(title);
    }
    return title;
  });
  return entries.map((entry, index) => {
    const parents = (sources.get(entry.baseRevision) ?? []).filter(title => title !== titles[index]);
    return renderEntry(entry, titles[index], parents.length === 1 ? parents[0] : null);
  });
}

export function enableDesignHistory(source) {
  const trigger = document.querySelector('#open-history');
  const dialog = document.querySelector('#design-history');
  const close = document.querySelector('#close-history');
  const retry = document.querySelector('#retry-history');
  const status = document.querySelector('#history-status');
  const list = document.querySelector('#history-entries');
  let loading = false;
  let loaded = false;

  function updateUrl(open) {
    const url = new URL(location.href);
    if (open) url.searchParams.set('history', 'on');
    else url.searchParams.delete('history');
    history.replaceState(history.state, '', url);
  }

  async function load() {
    if (loading || loaded) return;
    loading = true;
    retry.hidden = true;
    status.textContent = 'Loading design history…';
    try {
      const response = await fetch(source);
      if (!response.ok) throw new Error('History request failed');
      const { entries } = await response.json();
      if (!Array.isArray(entries) || !entries.every(entry => entry &&
        Object.hasOwn(states, entry.status) && typeof entry.title === 'string' &&
        typeof entry.revision === 'string' && typeof entry.branch === 'string' &&
        (!entry.baseRevision || typeof entry.baseRevision === 'string') &&
        (!entry.mergedRevision || typeof entry.mergedRevision === 'string'))) {
        throw new Error('Invalid history entries');
      }
      list.replaceChildren(...renderEntries(entries));
      status.textContent = entries.length ? '' : 'No design changes have been recorded yet.';
      loaded = true;
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
  window.addEventListener('popstate', () => {
    if (new URL(location.href).searchParams.get('history') === 'on') open();
    else if (dialog.open) dismiss();
  });
  if (new URL(location.href).searchParams.get('history') === 'on') open();
}
