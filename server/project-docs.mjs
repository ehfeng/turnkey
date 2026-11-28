import schema from '../schemas/project-v1.json' with { type: 'json' };

export const projectSchema = schema;
const id = description => ({ type: 'string', minLength: 1, maxLength: 1024, description });
const operationId = id('Client-generated retry ID. Retry identical requests with the same ID; use a new ID when the payload changes.');
const expectedHeadRevisionId = id('Exact project branch head read before editing; stale writes fail without overwriting changes.');
const branch = id('Explicit project branch name. This is not a Git commit or furniture commit ID.');
const revisionId = id('Immutable project revision ID, not an unqualified latest version.');
const message = { type: 'string', maxLength: 4096, description: 'Human-readable reason for the change.' };
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties: { projectId: id('Project membership scope.'), ...properties }, required: ['projectId', ...required], additionalProperties: false });
const pagination = { cursor: { type: 'string', maxLength: 4096 }, limit: { type: 'integer', minimum: 1, maximum: 200 } };
const tools = [
  ['get_model_documentation', 'Read versioned project documentation, capability limits, coordinate conventions and complete workflow examples. Omit topic for an index.', input({ topic: { type: 'string' } }, []), false],
  ['get_project_revision', 'Read an immutable whole-project revision with its pinned component state, source provenance and completeness.', input({ revisionId }), false],
  ['list_project_history', 'Browse ancestry from an explicit project revision. Continue using the returned cursor; imported incomplete states remain marked.', input({ head: revisionId, ...pagination }, ['head']), false],
  ['list_branches', 'List project alternatives and their exact head revision IDs.', input({}), false],
  ['create_branch', 'Create a named alternative from a retained project revision. Does not alter its source branch.', input({ name: branch, fromRevisionId: revisionId, operationId }), true],
  ['compare_revisions', 'Compare two project states using stable entity IDs. Returns a semantic diff; does not write.', input({ from: revisionId, to: revisionId }), false],
  ['commit_changes', 'Save a complete supported project state against the explicit branch head. Preserve untouched components. Repository geometry changes require the project adapter and validation.', input({ branch, expectedHeadRevisionId, operationId, message, state: { type: 'object', description: 'Complete resolved state returned by get_project_revision, with supported edits applied.' } }, ['branch', 'expectedHeadRevisionId', 'operationId', 'state']), true],
  ['prepare_merge', 'Prepare a three-way merge pinned to both heads. Returns conflicts and validation without publishing the candidate.', input({ sourceBranch: branch, targetBranch: branch, expectedSourceHeadRevisionId: revisionId, expectedTargetHeadRevisionId: revisionId, operationId }), true],
  ['get_merge_plan', 'Inspect an immutable merge plan, candidate, conflicts and validation before accepting it.', input({ planId: id('Immutable merge plan ID.') }), false],
  ['resolve_merge_conflicts', 'Create a new immutable plan version with explicit resolutions. Inspect its validation and use its new ID to commit.', input({ planId: id('Plan being resolved.'), resolutions: { type: 'object', description: 'Map each conflict ID to {choice: base|target|source|value|delete, value?: JSON}. JSON null differs from delete.', additionalProperties: { type: 'object', required: ['choice'], properties: { choice: { type: 'string', enum: ['base', 'target', 'source', 'value', 'delete'] }, value: {} }, additionalProperties: false } }, operationId }), true],
  ['commit_merge', 'Publish a reviewed plan only if all conflicts are resolved, validation passes and both branch heads still match. This changes the target branch.', input({ planId: id('Exact reviewed plan version.'), operationId, message }, ['planId', 'operationId']), true],
  ['revert_revision', 'Restore a saved state by creating a new commit on the explicit branch. Preserve intervening history and validate against the current head.', input({ branch, expectedHeadRevisionId, revisionId, operationId, message }, ['branch', 'expectedHeadRevisionId', 'revisionId', 'operationId']), true],
  ['list_project_events', 'Read committed durable project events. Delivery may be repeated; deduplicate by event ID.', input({ cursor: { type: 'integer', minimum: 0 }, limit: pagination.limit }, []), false],
  ['get_operation_receipt', 'Recover the recorded result of an operation after a lost response. Absence does not grant permission to overwrite a moved branch.', input({ operationId }), false],
];

export const projectTools = tools.map(([name, description, inputSchema, mutates]) => ({ name, description, inputSchema, mutates,
  annotations: { readOnlyHint: !mutates, destructiveHint: mutates, idempotentHint: true, openWorldHint: false } }));
export const roomContextTool = { name: 'get_room_context', description: 'Read revision-pinned room geometry, images, measurements, uncertainty, evidence, decisions, permits and validation supported by the project adapter.', inputSchema: input({ revisionId, roomId: id('Stable room ID.') }), mutates: false, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };

const topics = {
  coordinates: 'Physical plan coordinates use millimeters: x right, y up-plan, z up; yaw degrees counterclockwise. Three.js meters/Y-up maps [x,y,z] to [x/1000,z/1000,-y/1000]. PNG region coordinates use 0..1, origin top left, x right and y down. A calibrated transform is required for physical scale.',
  ownership: 'The repository owns geometry, builders, measurements, evidence, decisions and permits. Application components own furniture, boards and image associations. Read projections never become a second independent geometry authority. Check capabilities before proposing geometric edits.',
  revisions: 'Project revisions pin all known component versions. A Git commit or furniture snapshot alone is not the whole project. Check completeness: imported partial history may not support editing or preview. Parent IDs preserve recorded ancestry; import does not invent links based on timestamps.',
  branches: 'Read branches, resolve its head, and create an alternative from that exact project revision. Every save names branch, expectedHeadRevisionId and operationId. A conflict preserves the existing head; fetch the new state and reconcile explicitly. Retries must retain the exact original payload.',
  merges: 'prepare_merge pins source and target heads and finds a common ancestor. Inspect conflicts and validation. Resolve conflicts into a new immutable plan; then commit that plan. A stale source or target invalidates publication. Merge commits retain both parents; unrelated owner decisions are never implicitly approved.',
  evidence: 'Retain original source files, measurement units/endpoints, source locations and uncertainty. Unknown values stay null; measured, reported, inferred and assumed values are distinct. Preserve conflicting readings and the rationale for choosing one.',
  permits: 'Existing, demolition and proposed states are distinct from alternatives. Frozen releases retain exact source and artifact references. Validation is not permit approval. Unknown required geometry remains a blocker.',
  images: 'Image roles are current photo, model render, inspiration or generated concept. Renders identify their input revision; generated concepts retain selected inputs and prompt. Generating images does not mutate spatial geometry.',
  validation: 'The project adapter validates domain rules and compatibility of changed geometry, frames and furniture. Unsupported geometric edits fail explicitly. Errors include code, field/path details when available and a documentation topic. Never retry a rejected geometry change by bypassing validation.',
  transport: 'HTTP and MCP use the same authorization, operation validation and store calls. MCP is stateless Streamable HTTP using JSON responses. Mutations require an authenticated server-resolved actor and project membership; the client cannot assert actor identity.',
};

export function getProjectDocumentation({ projectId, topic, capabilities = {}, tools = projectTools }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  if (topic === 'examples') return { schemaVersion: 1, topic, examples: workflowExamples(projectId) };
  if (topic && !Object.hasOwn(topics, topic)) return null;
  return { schemaVersion: 1, schemaUrl: `${base}/schemas/project-v1.json`, ...(topic ? { topic, text: topics[topic] } : {
    introduction: 'Read documentation and capabilities, resolve an exact revision, create an alternative, save supported changes, inspect a merge plan, and publish only after resolving conflicts.',
    supportedSchemaVersions: [1], topics: [...Object.keys(topics), 'examples'], capabilities,
    tools: tools.map(({ name, description }) => ({ name, description })),
  }) };
}

export function workflowExamples(projectId = 'example-house') {
  return [
    { tool: 'create_branch', arguments: { projectId, name: 'kitchen-option', fromRevisionId: 'revision-a', operationId: 'branch-operation-1' } },
    { tool: 'prepare_merge', arguments: { projectId, sourceBranch: 'kitchen-option', targetBranch: 'main', expectedSourceHeadRevisionId: 'revision-b', expectedTargetHeadRevisionId: 'revision-a', operationId: 'merge-prepare-1' } },
    { tool: 'get_merge_plan', arguments: { projectId, planId: 'plan-1' } },
    { result: { id: 'plan-conflicting', conflicts: [{ id: 'conflict-lamp-title', entityId: 'lamp', path: '/boards/pins/lamp/title', kind: 'value', base: 'Original lamp', target: 'Brass lamp', source: 'Oak lamp', present: { base: true, target: true, source: true }, choices: ['base', 'target', 'source', 'value', 'delete'] }], validation: { valid: false, errors: [] } } },
    { tool: 'resolve_merge_conflicts', arguments: { projectId, planId: 'plan-conflicting', resolutions: { 'conflict-lamp-title': { choice: 'source' } }, operationId: 'resolve-1' }, result: { id: 'plan-resolved', previousPlanId: 'plan-conflicting', conflicts: [], validation: { valid: true, errors: [] } } },
    { tool: 'commit_merge', arguments: { projectId, planId: 'plan-resolved', operationId: 'merge-resolved-1', message: 'Accept reviewed conflict resolution' } },
    { tool: 'commit_merge', arguments: { projectId, planId: 'plan-1', operationId: 'merge-commit-1', message: 'Accept reviewed kitchen alternative' } },
    { tool: 'revert_revision', arguments: { projectId, branch: 'main', expectedHeadRevisionId: 'revision-c', revisionId: 'revision-a', operationId: 'restore-1', message: 'Restore prior arrangement while retaining history' } },
    { error: { code: 'branch_conflict', message: 'The branch moved.', details: { currentHeadRevisionId: 'revision-d' }, schemaVersion: 1, documentationTopic: 'branches' }, recovery: 'Read current head, compare states and explicitly reconcile. Retrying an unchanged successful request uses its original operation ID; changed payloads require a new ID.' },
  ];
}
