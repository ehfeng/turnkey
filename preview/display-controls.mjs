// Keep the model fields visible on large screens and in a disclosure on smaller ones.
const compact = matchMedia('(max-width: 820px)');
const modelSettings = document.querySelector('#model-settings');
const menus = [modelSettings, document.querySelector('#display'), document.querySelector('#collaboration')];

function adaptModelMenu() {
  modelSettings.open = !compact.matches;
}
compact.addEventListener('change', adaptModelMenu);
adaptModelMenu();

function dismissMenus(event) {
  if (event.type === 'keydown' && event.key !== 'Escape') return;
  for (const menu of menus) {
    if (!menu.open || (menu === modelSettings && !compact.matches)) continue;
    if (event.type === 'pointerdown' && menu.contains(event.target)) continue;
    if (event.type === 'keydown' && menu.contains(document.activeElement)) menu.querySelector('summary').focus();
    menu.open = false;
  }
}
document.addEventListener('pointerdown', dismissMenus);
document.addEventListener('keydown', dismissMenus);
