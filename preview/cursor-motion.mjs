export function cursorInSpace(cursor, space) {
  return Boolean(space && (!cursor.space || cursor.space === space));
}

// Reproject the latest surface point as the receiving camera moves.
export function cursorPosition(cursor, projectWorld) {
  const point = cursor.world ? projectWorld(cursor.world) : cursor;
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? point : null;
}
