// Shared helpers for a room's furniture.csv. The viewer and scripts/validate.mjs parse each room's schedule with
// these functions and pass the rows for the selected option to buildRoom({ THREE, option, furniture }).
import { applyPlacement } from './frame.mjs';

export const FURNITURE_COLUMNS = [
  'item_id', 'name', 'phase', 'option_id', 'asset_path', 'spec_path',
  'size_x_mm', 'size_y_mm', 'size_z_mm', 'anchor', 'x_mm', 'y_mm', 'z_mm', 'yaw_deg',
  'clearance_neg_x_mm', 'clearance_pos_x_mm', 'clearance_neg_y_mm', 'clearance_pos_y_mm',
  'measurement_refs', 'notes',
  // Optional fields for project-specific scopes of work.
  'trade', 'position', 'name_zh', 'scope_flag',
];
export const NUMERIC_COLUMNS = FURNITURE_COLUMNS.filter((c) => c.endsWith('_mm') || c === 'yaw_deg');
export const PHASES = ['existing', 'demolition', 'proposed'];
/** Trades for the scope of work, in the order it lists them. Demolition rows always sort into `demolition`. */
export const TRADES = [
  'demolition', 'plumbing', 'hvac', 'tile-waterproofing', 'electrical', 'carpentry-install', 'glass', 'wallpaper', 'paint',
];
/** `scope_flag` values: bold the item in the scope of work. */
export const SCOPE_FLAGS = ['changed', 'blocks-pricing'];

/** Parse RFC 4180 CSV text into an array of string arrays. */
export function parseCsvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Parse CSV text into `{ header, records }` where each record maps column name to its string value. */
export function parseCsv(text) {
  const [header = [], ...body] = parseCsvRows(text);
  const records = body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])));
  return { header, records };
}

/** Furniture rows with numeric columns converted to numbers (blank stays null). */
export function parseFurniture(text) {
  return parseCsv(text).records.map((record) => {
    const row = { ...record };
    for (const column of NUMERIC_COLUMNS) {
      const value = String(record[column] ?? '').trim();
      row[column] = value === '' ? null : Number(value);
    }
    return row;
  });
}

/** Option IDs used in a furniture schedule. */
export function furnitureOptions(rows) {
  return [...new Set(rows.map((r) => r.option_id).filter(Boolean))].sort();
}

/** All selectable IDs, including study options that use only the default schedule rows. */
export function roomOptionIds(rows, module) {
  return new Set([...furnitureOptions(rows), ...(module.options ?? []).map(o => typeof o === 'string' ? o : o.id)]);
}

/**
 * Compare resolved rows to independently modelled anchors and envelopes in room-local mm.
 * Supply each item's known x, y, z, size [x, y, z], yaw (degrees), and phase as applicable.
 * A standalone build may omit the schedule. A supplied empty schedule can have missing items.
 */
export function compareFurnitureSchedule(rows, expected, toleranceMm = 5) {
  if (rows === undefined) return [];
  const mismatches = [];
  for (const [id, anchor] of Object.entries(expected)) {
    const row = rows.find(r => r.item_id === id && (anchor.phase ? r.phase === anchor.phase : r.phase !== 'demolition'));
    if (!row) {
      mismatches.push(`${id}: missing ${anchor.phase ?? 'modelled'} item in furniture.csv`);
      continue;
    }
    const dimensions = {
      x_mm: anchor.x, y_mm: anchor.y, z_mm: anchor.z,
      size_x_mm: anchor.size?.[0], size_y_mm: anchor.size?.[1], size_z_mm: anchor.size?.[2],
    };
    for (const [field, value] of Object.entries(dimensions)) {
      if (value == null) continue;
      const actual = row[field];
      if (!Number.isFinite(actual) || Math.abs(actual - value) > toleranceMm) {
        mismatches.push(`${id}: ${field} is ${actual ?? 'blank'} in furniture.csv, model expects ${Number(value.toFixed(2))} mm`);
      }
    }
    if (anchor.yaw != null) {
      const yaw = row.yaw_deg ?? 0;
      const angle = ((yaw - anchor.yaw) % 360 + 540) % 360 - 180;
      if (Math.abs(angle) > 0.1) mismatches.push(`${id}: yaw_deg is ${yaw} in furniture.csv, model expects ${anchor.yaw}°`);
    }
  }
  return mismatches;
}

/**
 * Rows shown for an option, per templates/room/README.md: default rows (blank option_id), where a row for the
 * selected option replaces the whole default row with the same item_id and phase. Rows for other options are dropped.
 */
export function resolveFurniture(rows, option = '') {
  const chosen = new Map();
  for (const row of rows) {
    if (row.option_id && row.option_id !== option) continue;
    const key = `${row.item_id}\u0000${row.phase}`;
    if (!row.option_id && chosen.has(key)) continue;
    chosen.set(key, row);
  }
  return [...chosen.values()];
}

/** True when a row has a position the model can use. */
export function isPlaced(row) {
  return Number.isFinite(row.x_mm) && Number.isFinite(row.y_mm);
}

/** Place an object built in the item's local frame (metres, origin at its anchor) at the row's anchor and yaw. */
export function placeFromRow(object, row) {
  object.name ||= row.item_id;
  object.userData.itemId = row.item_id;
  return applyPlacement(object, { xMm: row.x_mm, yMm: row.y_mm, zMm: row.z_mm ?? 0, yawDeg: row.yaw_deg ?? 0 });
}

/**
 * A translucent envelope box for each placed row that has dimensions, for items with no model yet.
 * Assumes the anchor is the footprint centre at the underside; record other anchors in the row or model the item.
 */
export function buildFurnitureProxies(THREE, rows, { skip = new Set(), color = 0x9aa7b4 } = {}) {
  const group = new THREE.Group();
  group.name = 'furniture-proxies';
  const material = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.45, roughness: 0.8 });
  for (const row of rows) {
    if (skip.has(row.item_id) || row.phase === 'demolition' || !isPlaced(row)) continue;
    const { size_x_mm: sx, size_y_mm: sy, size_z_mm: sz } = row;
    if (![sx, sy, sz].every((v) => Number.isFinite(v) && v > 0)) continue;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx / 1000, sz / 1000, sy / 1000), material);
    mesh.position.y = sz / 2000;
    const holder = placeFromRow(new THREE.Group(), row);
    holder.userData.proxy = true;
    holder.add(mesh);
    group.add(holder);
  }
  return group;
}

export function isPlaceableAsset(entry) {
  return typeof entry?.name === 'string' && Boolean(entry.name.trim()) &&
    typeof entry.anchor === 'string' && Boolean(entry.anchor.trim()) &&
    ['size_x_mm', 'size_y_mm', 'size_z_mm'].every(key => Number.isFinite(entry[key]) && entry[key] > 0) &&
    ['offset_x_mm', 'offset_y_mm'].every(key => entry[key] === undefined || Number.isFinite(entry[key])) &&
    (entry.default_z_mm === undefined || (Number.isFinite(entry.default_z_mm) && entry.default_z_mm >= 0));
}
