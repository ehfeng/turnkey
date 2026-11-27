// Only a missing API on a static site falls back to the bundled, export-only viewer.
export async function openDesign(params, fetchImpl = fetch) {
  const request = { cache: 'no-store' };
  const response = await fetchImpl('./api/designs', request);
  const version = params.get('designVersion');
  const requestedBranch = params.get('designBranch');
  if (response.status === 404 || (response.ok && response.headers.get('content-type')?.includes('text/html'))) {
    if (version || requestedBranch) throw new Error('This link requires the shared design service.');
    return null;
  }
  if (!response.ok) throw new Error('The shared design could not be opened. Refresh to try again.');
  const index = await response.json();
  const branch = requestedBranch ?? index.branch;
  const target = index.branches?.find(entry => entry.name === branch);
  if (!target && requestedBranch && !version) throw new Error('This design branch could not be found.');
  const head = version ?? target?.head ?? index.head;
  if (!index.projectId || !branch || !head) throw new Error('The shared design has no current revision.');
  const commitResponse = await fetchImpl('./api/designs/commits/' + encodeURIComponent(head), request);
  if (!commitResponse.ok) throw new Error('This saved design version could not be opened.');
  const commit = await commitResponse.json();
  if (commit.id !== head || !commit.snapshot?.geometryRevision) throw new Error('Invalid saved design.');
  return { projectId: index.projectId, head, branch, snapshot: commit.snapshot, historical: Boolean(version),
    writable: index.writable !== false, authRequired: index.authRequired === true };
}
