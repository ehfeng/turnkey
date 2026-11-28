Turnkey’s primary interfaces are an LLM agent for research and design work and a website for viewing and editing the 3D model. It is primarily used by one person at a time, with occasional show and tell and light collaboration. Floor-plan navigation connects each room to its model, current photos, inspiration, and generated concepts. The user can ask an agent to interpret evidence, find products, propose changes, or generate images, then inspect and adjust the result on the website. Both interfaces work with the same project and revision history. Browser extensions are outside the product scope.

# Floor plans and room pins

Setup requires a PNG floor plan and room geometry in JSON. Accept PNG only for floor-plan images. The user maps and names room regions against the uploaded plan; the app stores those regions as JSON and the API accepts the same representation. Require a valid plan and at least one mapped room to complete setup.

The geometry JSON includes a schema version, a floor-plan reference, and a rooms array. Each room has a stable ID, a name, and an ordered polygon of [x, y] vertices. Coordinates are normalized from 0 to 1 against the full PNG, with the origin at the top left, x increasing rightward, and y increasing downward. Validate unique room IDs, nonempty names, finite coordinates within bounds, and polygons with at least three distinct vertices, nonzero area, and no self-intersections. The final vertex connects back to the first. These coordinates describe clickable regions, not physical measurements.

Display the PNG at its original aspect ratio with clickable room polygons overlaid. Clicking a region opens that room’s model workspace, with its reference images available alongside the 3D view. Keep stable room IDs when names or boundaries change so attached images remain in place. The room’s reference panel provides a responsive image grid and an Inbox holds material awaiting room assignment. A link without a photo gets a readable title and source domain. Opening a card shows the full image, original page, notes, who saved it, and when. New reference images appear first by default.

A pin can belong to several room boards. For example, save a faucet once, try it in two bathrooms, then mark it Chosen in one and leave it as an Idea in the other. Each board supports Idea, Shortlist, and Chosen filters, source or title search, bulk move or copy, and manual ordering. Dragging between two cards changes their order. A keyboard-accessible Move before or Move to top action does the same thing. The grid determines positions at each screen width.

# Room models and image context

Use a small, versioned JSON contract for agents over the existing hybrid architecture. The project repository remains authoritative for building geometry, custom builders, measurements, evidence, decisions, and permit records. The application service owns furniture layout snapshots, pins, and image associations. Each field has one authoritative owner; API geometry is a documented projection of repository data, not an independently writable second model. Geometry tools produce repository changes through supported adapters or builder edits; unsupported edits return a clear limitation. Preserve Turnkey’s existing room, level, and asset builder interfaces. IFC is deferred; rendered scenes and optional GLB exports are derived artifacts.

Keep stable IDs for rooms, walls, openings, furniture instances, evidence, and decisions. Match the existing project convention: physical plan coordinates use millimeters, x right, y up-plan, z up; yaw is degrees counterclockwise in plan. The Three.js scene uses meters with Y up, mapping [x, y, z] to [x/1000, z/1000, -y/1000]. Document the calibrated transform from normalized PNG coordinates into the physical plan; polygons alone do not establish scale. Preserve source measurements in their original units alongside normalized values. Unknown dimensions remain null, with measured, reported, inferred, and assumed values explicitly distinguished.

Link images to room and object IDs with explicit roles: current photo, model render, inspiration, or generated concept. Store descriptive annotations and camera information when known. Model renders identify the model revision; generated concepts retain their selected input image IDs and prompt. Generating an image does not change spatial geometry.

Agents submit model changes as proposals on a project branch against an explicit base project revision, with a rendered preview and validation results. Preserve the accepted branch until the user applies the proposal. Applying a proposal uses the same guarded merge flow as any other branch change. A stale base requires reconciliation and a fresh preview before acceptance.

# Project records and evidence

The project is more than geometry. Preserve the existing repository’s records and expose them through agent-readable context and versioned references. The API must not flatten uncertainty or discard project-specific information.

| Record | Required information and behavior |
| --- | --- |
| Measurement | Stable ID, value and original units, normalized value, endpoints or location, related room/object IDs, method, measured/reported/inferred/assumed classification, source references, and uncertainty when known. Retain conflicting readings and the rationale for selecting one. |
| Source evidence | Original file or immutable asset reference, source URL/path, capture date when known, author/provider, and precise page, crop, or annotation where applicable. Retain original evidence when interpretations change. |
| Owner decision | Stable ID, question, alternatives, chosen option, rationale, actor, date, affected objects, and supporting evidence. Record superseding decisions without erasing prior ones. Distinguish a proposal from an accepted owner decision. |
| Permit record | Existing-condition baseline, demolition and proposed changes, scope, supporting documents, submission/review status, and frozen release references. Design alternatives and permit states are separate concepts; passing validation does not mean permit approval. |
| Validation | Versioned generic rules and project-specific validators, their code revision, input project revision, results, affected objects, evidence references, and actionable blockers. Unknown required measurements block the relevant operation rather than becoming invented dimensions. |

Repository paths and JSON projections are linked by stable IDs and explicit source ownership. Source files and frozen permit deliverables are retained; corrections create a new revision. Tool results provide a concise summary plus links or IDs for retrieving detailed records. A project revision includes these records through its pinned repository commit, alongside application-owned design state.

# Project history, branching, and merging

History is a first-class data and API contract. Every saved project state is an immutable ProjectRevision; a Branch is a named pointer to one revision. A branch covers geometry, measurements, evidence, decisions, permit state, furniture layout, floor-plan mapping, pins, and image associations. Create alternatives from any retained revision without copying large media files. The website and agent always identify the branch and resolved revision; a historical view cannot accidentally write to the current branch.

A ProjectRevision is a versioned JSON manifest containing id, projectId, parentRevisionIds, createdAt, actor, message, operationId, affectedObjectIds, and immutable component references: repository commit, design snapshot, board/image-reference snapshot, catalog asset revisions, schema versions, and viewer/build artifact version. Zero parents denotes an imported root, one a normal change, and two a merge. Components unchanged by a commit reuse their references. Neither a Git commit nor a furniture commit alone identifies the whole project. Never resolve an old revision using “latest” geometry, assets, or builder code.

Preserve the existing furniture snapshot contract, including schemaVersion, geometryRevision, and instances with stable IDs, assetRevision, xMm, yMm, zMm, and yawDeg. The enclosing project manifest adds complete history without requiring a second geometry representation. Retain the pinned Turnkey package and project hooks needed to interpret each saved revision. Exact stored renders remain available even where rebuilding historical code is unavailable; expose that limitation explicitly.

Every mutation takes projectId, an explicit branch, expectedHeadRevisionId, and an operationId. The service validates the request and advances the branch with compare-and-swap. A stale head returns HTTP 409, or the equivalent structured MCP conflict, including the current head; it never silently overwrites intervening work. An identical retry returns its original receipt, while reuse of an operation ID with a different payload fails. Drafts and proposed merge resolutions survive conflicts. Branch creation also uses an explicit source revision and an idempotent operation ID.

Merge uses a common ancestor and a three-way comparison of base, target, and source. Match records by stable IDs, not array positions. Independent field changes can merge automatically only after validation. Conflicting values on the same field, edit-versus-delete, incompatible geometry or placement changes, colliding IDs, and contradictory owner decisions require explicit resolution. Return each conflict with entity ID, field path, base/target/source values, and resolution options. If no unambiguous merge base exists, require an explicit reviewed base or report that the merge is unsupported.

Preparing a merge creates an immutable MergePlan pinned to both branch heads and the merge base. It includes the candidate diff, conflicts, preview, and validation results. Committing it requires resolved conflicts, passing required validation, and unchanged source and target heads. The new ProjectRevision records both parents and the resolutions, and atomically advances the target branch in the project service. Source history is retained. Accepting a geometry proposal follows this flow; it does not silently accept unrelated owner decisions or alter a frozen permit release.

Repository-backed changes use Git branches and reviewed merge commits or equivalent retained Git history. Application-owned records use the same project-level merge plan. When geometry changes, explicitly reconcile furniture placements, room associations, coordinate transforms, and shared walls/openings against the candidate geometry. Preserve old layouts against their original geometry. If a migration cannot be validated, block completion and request a resolution; never simply relabel an old layout with a new geometry revision.

Git, object storage, and the project database do not share a transaction. Prepare immutable component revisions and artifacts first, then publish the complete project manifest, branch advance, receipt, and outbox event in one project-service transaction. Use a durable operation/job record to recover interrupted preparation and deduplicate Git callbacks. Failed preparation leaves the accepted project head unchanged; unused artifacts can be collected only when no retained revision references them. A Git merge alone does not publish an incomplete project revision.

History supports paginated ancestry, semantic diffs, exact revision reads, branch comparisons, and restoring an earlier design through a new revert commit. Reverting preserves history and requires validation against the current head. Shared branch history is not rewritten. Named releases pin an exact project revision and their deliverables; branch deletion never deletes revisions still referenced by another branch or release. Project membership and access checks apply equally to historical records and branches.

Current implementation boundary: Turnkey already has furniture commits, branch heads, retry receipts, and expected-head checks, while Dayst keeps geometry and project records in Git. The inspected design-commit schema has one parent and is not a complete merge DAG. Add the project manifest and multi-parent history layer deliberately. Import existing revisions with their known geometry/layout associations and original IDs, preserving recorded ancestry; mark missing associations or unavailable history rather than inventing them. Full project merging is a new capability, not an existing guarantee.

# Agent and website workflow

The agent is the primary interface for describing intent, interpreting plans and photos, researching products, and proposing model changes. Users can provide images, product links, measurements, and instructions through their agent or upload images and paste links directly on the website. Agents attach supplied material to the relevant room or model object through the shared tools, preserving source URLs and product variant parameters.

The website is the visual workspace: navigate the house, floors, rooms, and walls; inspect the 3D model; place, move, and rotate furniture; review proposals; and compare design revisions. Show current photos, inspiration, and generated concepts beside the selected room or object. Keep the active branch visible and provide history, create-alternative, compare, merge-preview, conflict-resolution, and restore actions. Share links identify the room/object and exact project revision, with an explicit option to follow a branch. Subsequent agent context resolves the same saved state.

Website and agent saves use client-generated operation IDs. Show Pending until the server confirms a write, preserve website drafts across reconnects, and retry with the same ID. Store the supplied image copy separately from its source-page and image URLs. When an image cannot be retrieved, retain a link-only reference and allow a direct upload later. An exact repeat in the same room returns the existing pin; two different photos from the same product page can be separate pins.

# Research from ChatGPT and Claude

Example request: “Find three wall-mounted oak vanities under 36 inches wide. Save them to Primary Bathroom with the width, listed price, and product link.” Each result becomes its own pin, so either person can shortlist it independently. Keep the original source, a short rationale, optional price and currency, dimensions with units, and the date checked. Leave unknown values blank. Record the person who saved it and the assistant used.

Provide list_boards, search_pins, get_pin, and save_pins through the shared agent interface. Reads identify an explicit revision or resolve a branch once and return that revision. The batch save tool takes the common branch, expected-head, and operation-ID fields, an explicit board ID, and up to 20 items. Return the project revision, room link, and a result per item with its pin ID and created, existing, or invalid status. Add explicit room assignment and pin status tools under the same permissions as the website. Model tools create reviewable proposals. Keep deletion and applying a proposal explicit, permission-checked actions.

ChatGPT, Claude, and other compatible agents use the remote MCP connection when their host and account support it; other integrations can use the HTTP API. Preserve individual retailer or publication URLs, supplied images, and an optional conversation link when saving research. Flag entries without usable sources. When a connection is unavailable, users can upload images or paste product links directly on the website. [ChatGPT connector availability](https://help.openai.com/en/articles/12584461) · [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

# HTTP API and MCP tools

Use the authenticated HTTP API as the foundation for rooms, images, model revisions, and jobs. Expose an authenticated remote MCP endpoint over Streamable HTTP on the same Worker for agent discovery and tool calls. Both interfaces call the same application services for permissions, validation, concurrency checks, and idempotent writes. MCP handlers need not make a second HTTP request internally. Use per-user OAuth scopes and project membership checks for agent access.

Prefer semantic tools for normal agent work. Provide get_room_context for geometry, linked images, measurements and uncertainty, source evidence, owner decisions, permit state, validation results, and the resolved project revision. Add tools such as add_window, place_furniture, attach_image, and render_room as capabilities ship. Geometry edits target a proposal branch and the repository’s authoritative source. Each tool documents units, coordinates, source ownership, references, effects, and returned IDs. Raw JSON import/export uses the same versioned schemas; do not accept unsupported builder edits through a generic JSON overwrite. Long-running rendering, validation, generation, or Git preparation returns a job ID with readable status and revision-pinned results.

HTTP and MCP expose the same project-history operations and conflict semantics. Suggested contracts are:

| Operation | HTTP API | MCP tool |
| --- | --- | --- |
| Read exact state | GET /projects/{id}/revisions/{revisionId} | get_project_revision |
| Browse ancestry | GET /projects/{id}/history?head={revisionId}&cursor={cursor} | list_project_history |
| List/create alternatives | GET or POST /projects/{id}/branches | list_branches / create_branch |
| Compare states | GET /projects/{id}/diff?from={revisionId}&to={revisionId} | compare_revisions |
| Save supported changes | POST /projects/{id}/commits | commit_changes |
| Prepare merge | POST /projects/{id}/merge-plans | prepare_merge |
| Submit explicit resolutions | POST /projects/{id}/merge-plans/{planId}/resolutions | resolve_merge_conflicts |
| Publish reviewed merge | POST /projects/{id}/merge-plans/{planId}/commit | commit_merge |
| Restore via new commit | POST /projects/{id}/reverts | revert_revision |

Mutation endpoints use the common operation-ID and expected-head contract. Merge preparation takes source and target branches plus their expected heads; resolution produces a new immutable plan version, and commit names that version. Reads return resolved revision IDs and pagination cursors where needed. The documentation includes full request/response examples for branching, a clean merge, a conflicting merge, a stale head, a retry, and a revert.

# Documentation discovery

Expose get_model_documentation through MCP and an equivalent HTTP documentation endpoint. Without a topic, return a short introduction, supported schema versions, available capabilities, and a topic index. Topics cover coordinates, rooms, walls, openings, images, measurements, evidence, decisions, permits, project validation, source ownership, project revisions, branches, merge conflicts, proposals, and complete examples. MCP resources may expose the same material; the callable documentation tool remains available for hosts that primarily support tools.

Publish versioned JSON Schemas at stable URLs. New exported documents identify their $schema URL and schemaVersion; adapters explicitly document any legacy field names. Define schemas for ProjectRevision, Branch, MergePlan, conflict records, component references, and domain projections. Tool results identify their schema and resolved project revision. Maintain one authoritative schema source and reuse field definitions in validation and tool arguments. Validate documentation examples against it and publish migrations for incompatible versions.

Validation errors include an error code, field path, actionable explanation, schema version, and documentation topic. For example, an opening that exceeds its wall returns the maximum valid offset and a reference to wall_openings. Agents should be able to discover tools, retrieve only the documentation they need, propose a change, and inspect its preview without searching for external instructions.

# Events and future webhooks

Record durable events from the first release. The project service transaction publishes each accepted revision, branch advance, mutation receipt, and outbox event together after referenced Git and asset work is durable. Events carry a unique ID, type/version, timestamp, project and room IDs where applicable, branch, previous and resulting project revisions, affected object IDs, actor, and causation/operation ID. Include branch.created, project.revision_committed, project.merged, and proposal events as applicable. Git callbacks are deduplicated inputs to reconciliation, not evidence that project publication succeeded. Store references rather than image bytes. Presence is ephemeral.

Add outbound webhook subscriptions and delivery in a later phase. Deliver committed events from a durable outbox to authorized HTTPS endpoints with signed payloads, retries, and visible delivery status. Assume at-least-once delivery: receivers verify signatures and deduplicate event IDs. Fetch the event’s exact revision for reproducible context, then check the target branch head before proposing any mutation. Filter subscriptions by project, branch, event type, and relevant room. Use origin and causation metadata plus explicit trigger rules to prevent recursive agent-trigger loops.

The initial automation flow is: the user requests an updated room model; Turnkey records room.model_update_requested; a webhook reaches an agent runner; the runner starts an agent that reads context and uses MCP or HTTP tools; the agent saves a proposal and preview; Turnkey emits model.proposal_created and shows the result. Photo uploads may emit image.added, but automatic model regeneration requires an explicitly configured workflow.

An agent runner starts and manages model API work and writes results back to Turnkey. An outbound webhook does not itself resume a chat. MCP change notifications likewise do not guarantee an agent run. Direct triggering of ChatGPT or another hosted agent requires a supported event integration for that host. Verify that capability before promising updates into an existing conversation. ChatGPT documentation currently describes event-triggered tasks for supported app events; it does not establish a general Turnkey webhook for resuming arbitrary chats. [ChatGPT event-triggered tasks](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)

A runner we control can receive Turnkey events and initiate model API requests. Provider completion webhooks can report results back to that runner; these are a separate direction of delivery from Turnkey’s outbound events. Store the association between event, job, provider request, and resulting proposal for recovery. [OpenAI API webhooks](https://developers.openai.com/api/docs/guides/webhooks)

# Live cursors and pin indicators

When both collaborators have the same board open, show a named cursor over the pin the other person is pointing at. Anchor the cursor to the pin ID and a position within the original image, normalized from 0 to 1 on each axis. Each browser maps that point through its own image scale and crop. A pointer outside the image, a link-only pin, or a point cropped out on the receiving screen gets a highlight on the card. Hide the cursor in the gaps between cards.

Opening a pin shows “Sherry is viewing” on the card. Dragging shows “Sherry is moving” on the source card and a marker beside the intended destination pin. The shared order updates when the drop commits. If an active pin is offscreen, show its title with a **Jump to pin** action. Scrolling stays under each person’s control. Show presence only on the matching board, and use names as well as color so the indicators are readable.

# Storage and live collaboration

Build on the existing Cloudflare Worker deployment and Durable Objects with SQLite used for design state and collaboration. Add the HTTP/MCP application services and project-history coordinator there; migrating to D1 is not a prerequisite. Git remains authoritative for repository-owned records, and the application store owns its versioned design records and project manifests. Private object storage such as R2 holds image copies, thumbnails, and retained artifacts. Asset delivery and mutations enforce the project’s access rules. Keep image bytes off signaling and presence channels.

Use one WebRTC peer connection between the two foreground board sessions. Send pointer samples over an unordered data channel with zero retransmissions, capped at 20 per second while moving. Include the board, pin, coordinates, and a sequence number. Discard older samples and interpolate between recent points. A reliable ordered channel carries viewing and drag state, clears, and the refresh hint after a committed edit. Send current presence on connection. Keep presence in memory. [WebRTC data channels](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel)

Establish the connection through the project-scoped authenticated HTTPS signaling mailbox with STUN and a deterministic initiator. Clear indicators on board change, tab hide, or disconnect. A two-second heartbeat expires stale presence after six seconds if a peer disappears silently. On a blocked direct route, show live presence as unavailable and continue HTTP board refresh. The first release uses direct connections.

Website and agent writes use the same authenticated application services. Direct repository work enters through revision import and validation before publication. Each visible tab uses a conditional snapshot endpoint scoped to project, branch, and board, with an ETag identifying the resolved project revision and representation. Return 304 if unchanged, otherwise board metadata and pins from one consistent revision; images load separately. Historical revision views remain pinned and do not poll forward. Allow one refresh in flight, coalesce triggers, and preserve pending edits and note drafts when replacing the saved view.

Each visible tab checks once per second, on a peer hint, and immediately on open, focus, or network recovery. Hidden tabs pause polling. Website and agent saves are picked up by the next check, even when WebRTC is unavailable. Opening a board later uses the same endpoint. Board refresh requires no polling leader, change replay, or cursor recovery; durable automation events are handled separately.

# Data and conflict rules

Core application records are Project, Member, FloorPlan, Board, Pin, BoardPin, Asset, MutationReceipt, ProjectRevision, Branch, and MergePlan. FloorPlan references an immutable PNG and versioned region JSON. Stable room IDs link to Boards; the Inbox has no region. Pin stores product details and provenance; BoardPin stores room-specific status and ordering. Store these as revision-addressable state, not only mutable current rows. Project identifies its default branch; each Branch identifies its head. MutationReceipt binds the operation ID and request payload to its result. Membership and delivery configuration are operational state, not rewound by design branching.

Add Event for durable automation events, ModelProposal for branch-based review, ImageReference for revisioned image associations, and Job for long-running work. Expose Measurement, SourceEvidence, OwnerDecision, PermitRecord, and ValidationResult through schemas linked to their authoritative repository records or immutable result artifacts. Reuse ProjectRevision for whole-model history rather than introducing an unrelated room revision counter. Add WebhookSubscription and WebhookDelivery when delivery ships. Preserve causation and project revision references across records.

Patch only changed fields and require the expected branch head. On a stale head, preserve the draft and return a conflict; the client may prepare a three-way reconciliation and retry against the new head. Independent changes can survive reconciliation, while same-field status or note conflicts require an explicit choice. Reorders refer to stable neighboring pin IDs and are validated against the candidate state; incompatible concurrent ordering requires resolution. Removing a pin from one board preserves other memberships and prior revisions. Presence is scoped to the same project, branch, and board.

Upload media under a private temporary key before committing the pin. After a confirmed upload the transaction attaches the asset. Expire unattached uploads. A retry with the same operation ID returns the original result. For an AI pin without a supplied image, create the link card immediately. The user can attach an exact photo later.

# Delivery and acceptance

Build on the existing website’s 3D viewing, furniture editing, and revision history. First formalize source ownership, versioned project manifests, branch-aware reads/writes, and migration from existing Git and layout history. Then ship documented HTTP/MCP context tools, image intake, semantic proposals, comparison, and reviewed merges with project validation. Preserve PNG floor-plan input and JSON room mapping. Keep reusable infrastructure in Turnkey and project-specific records, builders, validation, and deployment adapters in the project repo; account for Dayst’s pinned Turnkey package rather than assuming it runs current main. Record durable publication events. Show and tell remains independent of automation. Webhook delivery and an agent runner follow later; hosted-chat triggers depend on verified platform support.

- Save two different photos from one retailer page through agent tools or direct website uploads. Both retain the correct image and product link. Retrying either save produces one pin for that image.

- Upload a PNG and save room geometry as JSON. Reload and resize the plan; each region must remain aligned and open the correct room. Reject non-PNG floor plans and invalid geometry. Renaming a room or editing its boundary must preserve its pins.

- Seed 1,000 pins. Verify grid browsing, search, room assignment, and identical manual order across two desktop widths.

- Across 100 edits with two connected foreground browsers, target p95 of two seconds or less from server acknowledgement to visible metadata update. Measure direct WebRTC, external assistant saves, and HTTP fallback separately. Image upload and full-image loading have separate timings.

- Open one board at two widths and scroll independently. Point to the faucet in a vanity photo and verify the cursor stays on the faucet after resize. Open an offscreen pin, jump to it, preview a drag, then cancel it. Confirm the saved order and project revision are unchanged by presence alone.

- Test rapid motion with dropped and reordered pointer samples. Verify stale samples cannot rewind the cursor. Switch boards, hide a tab, and simulate an abrupt disconnect. Confirm stale indicators expire within six seconds and committed pins still sync with WebRTC blocked.

- Close the website, have an agent save three research results with source links to a room, then reopen it. Both users see the batch in the room’s reference panel. Replay the request and verify zero duplicates.

- Block WebRTC, suspend a tab, interrupt an upload, and race two edits. Verify recovery, preserved notes, correct revision order, and private asset access.

- Target $0 incremental monthly hosting cost at household usage. Two foreground tabs checking once per second for two hours generate 14,400 scheduled checks, plus saves, peer-triggered refreshes, and asset requests. Measure request usage and changed-snapshot size with 1,000 pins. [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/)

- Starting with only the MCP tool list, have an agent discover the model documentation, read a room, propose a valid window, and inspect a preview. Invalid dimensions must return a useful correction and documentation topic.

- Verify equivalent HTTP and MCP operations enforce the same permissions, validation, and retry behavior. A stale model proposal must preserve the accepted revision and intervening edits.

- Verify publication creates its durable event once under retries and a rolled-back publication creates none. Interrupt preparation after a Git commit or asset upload and verify recovery cannot advance the project branch to incomplete state. Deduplicate repeated Git callbacks and webhook deliveries separately. Presence alone creates no durable event.

- When webhook delivery ships, interrupt delivery and replay events. Verify signature checks, retry recovery, deduplication, current-state fetching, and no recursive agent-trigger loop. Complete a model-update request through the runner and show the resulting proposal in Turnkey.

- Measure rendering, model API, and webhook delivery costs separately from the household board-hosting target.

- Complete the core workflow through an agent and the website: attach a room photo, propose a model change, open the linked room and revision, inspect the preview, and edit furniture placement visually. Verify subsequent agent context reflects the saved website edit.

- Read a historical project revision after changing geometry, furniture, pins, evidence, and decisions. Verify every component resolves to its pinned version and frozen permit deliverables remain unchanged.

- Create two alternatives from one revision. Merge independent edits with both parents retained; surface explicit conflicts for same-field edits, edit-versus-delete, incompatible geometry/placements, and contradictory owner decisions.

- Change either branch head after preparing a merge. Reject the stale plan without losing its resolutions or changing the target; recompute and validate before committing.

- Change a wall or room footprint and verify affected placements, source references, shared features, and project-specific validation are reconciled before acceptance. Keep the old layout readable with its original geometry.

- Retry a commit, merge, or revert and verify a single resulting revision and receipt. Restore an older design through a new commit while retaining intervening history.

- Import existing Git and furniture history without fabricating missing ancestry. Verify an agent can discover the documentation, branch a design, inspect evidence and decisions, resolve a conflict, and submit a reviewable merge through either HTTP or MCP.
