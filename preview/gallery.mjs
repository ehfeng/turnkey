// The library contains image URLs. Setting the active image's src fetches its bytes.
export function createPreviewGallery(document, { preference, onToggle }) {
  const el = id => document.querySelector('#' + id);
  const panel = el('preview-gallery'), toggle = el('show-previews');
  const image = el('gallery-image'), original = el('gallery-original');
  const previous = el('gallery-prev'), next = el('gallery-next'), expand = el('gallery-expand');
  const collection = el('gallery-collection'), jump = el('gallery-jump');
  let library = [], matches = [], scopeId = '', generation = 0;
  let open = Boolean(preference), choice = preference;
  const positions = { view: 0, all: 0 };

  function source() {
    if (choice === 'all' || choice === 'view') return choice;
    return scopeId === 'house' ? 'all' : 'view';
  }

  function setExpanded(value) {
    panel.classList.toggle('expanded', value);
    expand.setAttribute('aria-pressed', String(value));
    expand.textContent = value ? 'Show model' : 'Enlarge';
  }

  function display() {
    const mode = source();
    const entries = mode === 'all' ? library : matches;
    const index = positions[mode];
    const item = entries[index];
    collection.value = mode;
    toggle.disabled = !library.length && !matches.length;
    toggle.checked = open && !toggle.disabled;
    panel.hidden = !toggle.checked;
    el('preview-count').textContent = String(entries.length);
    el('preview-control').title = toggle.disabled ? 'No photo previews available' : 'Show or hide photo previews';
    if (panel.hidden) return;
    previous.disabled = next.disabled = entries.length < 2;
    el('gallery-position').textContent = item ? (index + 1) + ' / ' + entries.length : '';
    el('gallery-picker').hidden = mode !== 'all' || entries.length < 2;
    el('gallery-figure').hidden = !item;
    el('gallery-empty').hidden = Boolean(item);
    if (!item) return;
    if (mode === 'all') jump.value = String(index);
    el('gallery-owner').textContent = item.owner;
    el('gallery-title').textContent = item.title;
    el('gallery-caption').textContent = item.caption;
    if (image.getAttribute('src') !== item.url) {
      el('gallery-error').hidden = true;
      original.hidden = false;
      image.alt = item.title;
      original.href = image.src = item.url;
    }
  }

  function setOpen(value) {
    open = value;
    if (!value) setExpanded(false);
    display();
  }

  function choose(delta) {
    const mode = source();
    const total = (mode === 'all' ? library : matches).length;
    if (total < 2) return;
    positions[mode] = (positions[mode] + delta + total) % total;
    display();
  }

  function close() {
    setOpen(false);
    onToggle(false, choice);
    toggle.focus();
  }
  toggle.addEventListener('change', () => {
    setOpen(toggle.checked);
    onToggle(open, choice);
    if (open) panel.focus();
  });
  collection.addEventListener('change', () => {
    choice = collection.value;
    display();
    onToggle(open, choice);
  });
  jump.addEventListener('change', () => {
    positions.all = Number(jump.value);
    display();
  });
  el('gallery-close').addEventListener('click', close);
  previous.addEventListener('click', () => choose(-1));
  next.addEventListener('click', () => choose(1));
  expand.addEventListener('click', () => setExpanded(!panel.classList.contains('expanded')));
  panel.addEventListener('keydown', event => {
    if (event.target === collection || event.target === jump) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowLeft') choose(-1);
    else if (event.key === 'ArrowRight') choose(1);
    else if (event.key === 'Escape') close();
    else return;
    event.preventDefault();
  });
  image.addEventListener('error', () => {
    if (!image.getAttribute('src') || image.naturalWidth) return;
    original.hidden = true;
    el('gallery-error').hidden = false;
  });

  function setLibrary(entries) {
    library = entries;
    const groups = new Map();
    for (const [index, item] of entries.entries()) {
      if (!groups.has(item.owner)) {
        const group = document.createElement('optgroup');
        group.label = item.owner;
        groups.set(item.owner, group);
      }
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = item.title;
      groups.get(item.owner).append(option);
    }
    jump.replaceChildren(...groups.values());
    display();
  }

  function clear(nextScope) {
    ++generation;
    scopeId = nextScope;
    matches = [];
    positions.view = 0;
    display();
  }

  async function load(getEntries) {
    const request = ++generation;
    try {
      const result = await getEntries();
      if (request !== generation) return;
      matches = result;
      display();
    } catch (error) {
      if (request === generation) console.warn('Could not load photo previews:', error);
    }
  }

  function restore(value) {
    choice = value;
    setOpen(Boolean(value));
  }

  function showImage(url) {
    const mode = source();
    const found = (mode === 'all' ? library : matches).findIndex(entry => entry.url === url);
    if (found === -1) return false;
    positions[mode] = found;
    setOpen(true);
    onToggle(true, choice);
    panel.focus();
    return true;
  }
  return { setLibrary, clear, load, restore, showImage };
}
