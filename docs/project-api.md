# Project HTTP and MCP interfaces

The interfaces share `createProjectService` and the immutable project store. They do not provide a second write path. Mount `handleProjectRequest(request, service)` at `/api/projects/{projectId}` and `handleProjectMcpRequest(request, service)` at `/api/mcp`.

```js
const service = createProjectService({
  store,
  async authorize(request, { projectId, action, tool }) {
    // Verify session/OAuth token, scope and project membership in the host.
    // Return null for unauthenticated access, or throw a 403 DesignError
    // for an authenticated principal without the required permission.
    return { actor: verifiedPrincipal };
  },
  capabilities: { geometryEditing: false },
});
```

Authorization is required for every read, discovery call and mutation. Omitting it denies access. The host owns OAuth and session verification; this package does not claim that returning an object verifies a token. Writes require a non-null trusted actor. Client-supplied actor fields are rejected. A browser Origin must match the endpoint origin unless explicitly included in `allowedOrigins`. No permissive CORS headers are emitted. Use TLS at the deployment boundary.

For remote agents, `createBearerProjectAuthorizer({verifyToken,projectId,resource,resourceMetadataUrl})` accepts an injected cryptographic verifier. That verifier must check signature, issuer, expiry and not-before and return verified claims. The adapter additionally requires `sub`, the exact resource in `aud`, project membership in the `projects` array, and `turnkey:read` or `turnkey:write` in the space-separated `scope`. A write-enabled agent needs both scopes because MCP discovery requires read access. Invalid or missing tokens return an HTTP 401 Bearer challenge; foreign projects and missing scopes return 403. Actor identity comes from the verified subject and issuer.

`createProjectResourceMetadata({resource,authorizationServers})` produces OAuth protected-resource metadata only with explicit HTTPS resource and issuer configuration. The host publishes it at the URL used in the challenge. Configure a real authorization server and verifier before advertising remote OAuth support; cookie sessions alone do not provide remote agent authorization.

## HTTP routes

All paths below follow `/api/projects/{projectId}`. Responses are JSON and `Cache-Control: no-store`.

| Method/path | Input | Result |
| --- | --- | --- |
| GET `/documentation?topic=...` | Optional topic | Documentation index or topic |
| GET `/schemas/project-v1.json` | None | Versioned JSON Schema |
| GET `/branches` | None | `{schemaVersion, projectId, branches:[{name,headRevisionId}]}` |
| POST `/branches` | `name, fromRevisionId, operationId` | Branch and head |
| GET `/revisions/{id}` | None | Revision metadata and resolved `state` |
| GET `/history?head=...&cursor=...&limit=...` | Explicit head; opaque cursor, limit 1–200 | Revisions and `nextCursor` |
| GET `/diff?from=...&to=...` | Exact revision IDs | Semantic changes |
| POST `/commits` | `branch, expectedHeadRevisionId, operationId, state, message?` | New revision and branch head |
| POST `/merge-plans` | Source/target branch, both expected head IDs, operation ID | Immutable candidate and conflicts |
| GET `/merge-plans/{id}` | None | Saved candidate plan |
| POST `/merge-plans/{id}/resolutions` | `operationId, resolutions` | New immutable plan version |
| POST `/merge-plans/{id}/commit` | `operationId, message?` | New merge revision and target head |
| POST `/reverts` | `branch, expectedHeadRevisionId, revisionId, operationId, message?` | New restore commit |
| GET `/events?cursor=0&limit=100` | Numeric event cursor | Durable events and numeric next cursor |
| GET `/operations/{operationId}` | Original retry ID | Original operation result |
| GET `/rooms/{roomId}/context?revisionId=...` | Exact revision | Optional adapter room context |

Request JSON is limited to 2 MiB. A stale head returns 409 and the current head ID. Error bodies are `{error:{code,message,details,schemaVersion,documentationTopic}}`. Known project validation failures retain their actionable details; unexpected internal exceptions do not expose stack traces or internal messages. History cursors are opaque strings; event cursors are integers. Branch names and IDs in URL segments must be URL encoded.

The resolved revision has `id`, `projectId`, `parentRevisionIds`, `components`, `completeness` and `state`. Component IDs are immutable references. Imported `source-only` states remain explicitly incomplete and cannot be silently edited as complete designs. Complete state includes repository, design, boards and viewer components. Read current state before editing and preserve untouched components. Physical geometry is in plan millimeters; the renderer converts to meters/Y-up.

## MCP transport

The endpoint implements stateless Streamable HTTP. Send POST with `Content-Type: application/json`, `Accept: application/json, text/event-stream`, and normal host authentication. It supports protocol versions `2025-06-18` and `2025-03-26`; initialize negotiates a supported version. Include the negotiated `MCP-Protocol-Version` on subsequent requests. The compatibility default for missing headers is `2025-03-26`.

Supported JSON-RPC methods are `initialize`, `ping`, `tools/list` and `tools/call`. Notifications return 202 and never mutate projects. No session ID is issued. GET/DELETE return 405 because unsolicited event streams and sessions are not implemented; durable project events are read through the explicit event tool. JSON-RPC batches are rejected. MCP errors preserve project error codes and details in `structuredContent.error` with `isError:true`; authentication failures retain HTTP 401/403.

Start with `get_model_documentation`. Tool discovery exposes only implemented capabilities. Optional `roomContext` receives `{revision,roomId}` and authenticated context; it must resolve records from that exact revision. Additional adapters can be registered with `{name,description,inputSchema,annotations,mutates,execute}`. They must include an explicit `projectId` argument and validate domain changes through the same store; never use an adapter to bypass publication validation. Unsupported geometry tools are not advertised.

## Reviewed merge example

1. `list_branches` → read `main` at `revision-a`.
2. `create_branch({projectId,name:"kitchen-option",fromRevisionId:"revision-a",operationId:"branch-1"})`.
3. Read `revision-a`, apply supported edits to its complete state, then `commit_changes` on the option branch with `expectedHeadRevisionId:"revision-a"`.
4. `prepare_merge` with both current branch heads. Inspect `candidate`, `diff`, `conflicts`, `validation` and `preview`. A `preview.status` of `not-generated` is not a rendered preview.
5. Resolve conflicts using `{[conflictId]:{choice:"source"}}`, or explicit `base`, `target`, `value` with a JSON `value`, or `delete`. Null is a value, not deletion. Resolution returns a new plan ID; the old plan remains unchanged.
6. Commit the reviewed plan using a new operation ID. Both heads must still match. If either moved, prepare a new merge and review it again.
7. Retry the exact same successful commit request using the same operation ID after a lost response. Reusing that ID with different data or a different actor fails.
8. To restore `revision-a`, use `revert_revision` against the current head. This appends a revision and preserves all intervening history.

Repository import and initialization are intentionally not remote tools. Import runs through the trusted migration path after validating source provenance and completeness. Webhook subscription/delivery and provider-specific chat resumption are separate later capabilities.
