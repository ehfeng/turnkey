// The static editor uses schedule rows. Keep that interface at the canvas boundary;
// collaborative operations always use a single versioned instance and its full pose.
export function placementRow(instance) {
  return {
    item_id: instance.id, asset_path: instance.assetRevision,
    x_mm: instance.xMm, y_mm: instance.yMm, z_mm: instance.zMm, yaw_deg: instance.yawDeg,
  };
}

export function placementInstance(roomId, row) {
  if (!row) return null;
  return {
    id: row.item_id, roomId, assetRevision: row.asset_path,
    xMm: row.x_mm, yMm: row.y_mm, zMm: row.z_mm, yawDeg: row.yaw_deg,
  };
}

function equalInstance(a, b) {
  if (!a || !b) return !a && !b;
  return ['id','roomId','assetRevision','xMm','yMm','zMm','yawDeg'].every(key => a[key] === b[key]);
}

export function createPlacementUndo() {
  const changes = [];
  const eligible = (change, instances) => {
    const id = (change.after ?? change.before).id;
    return equalInstance(change.after, instances.find(item => item.id === id));
  };
  function last(instances) {
    return changes.findLast(change => eligible(change, instances));
  }
  return {
    clear() { changes.length = 0; },
    record(change) { changes.push(change); },
    canUndo(instances) { return Boolean(last(instances)); },
    async undo(instances, apply) {
      const change = last(instances);
      if (!change) throw new Error('Your earlier edits have changed. There is nothing to undo.');
      await apply({ before: change.after, after: change.before });
      changes.splice(changes.indexOf(change), 1);
    },
  };
}

export function versionLink(location, name, value) {
  const url = new URL(location);
  url.hash = '';
  url.searchParams.delete('designVersion');
  url.searchParams.delete('designBranch');
  url.searchParams.set(name, value);
  return url.href;
}
