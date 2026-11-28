import { jsonResponse, projectError, projectErrorHeaders, readJsonRequest } from './project-api.mjs';

export const supportedMcpVersions = ['2025-06-18', '2025-03-26'];
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const accepts = (header, type) => header?.split(',').some(part => {
  const [media, ...params] = part.trim().toLowerCase().split(';').map(value => value.trim());
  return (media === type || media === '*/*') && !params.some(p => /^q=0(?:\.0*)?$/.test(p));
});

// Stateless Streamable HTTP: POST requests use JSON responses; unsolicited
// server streams and session deletion are intentionally unsupported (405).
export async function handleProjectMcpRequest(request, service) {
  let id = null;
  try {
    await service.authenticate(request, 'read', 'mcp');
    if (request.method !== 'POST') return jsonResponse(rpcError(null, -32000, 'Use POST. This MCP endpoint is stateless and has no server event stream.'), 405, { Allow: 'POST' });
    const accept = request.headers.get('Accept');
    if (!accepts(accept, 'application/json') || !accepts(accept, 'text/event-stream')) return jsonResponse(rpcError(null, -32000, 'Accept must include application/json and text/event-stream.'), 406);
    const message = await readJsonRequest(request);
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return jsonResponse(rpcError(null, -32600, 'Expected one JSON-RPC 2.0 request or notification.'), 400);
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && (typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isFinite(message.id)))) return jsonResponse(rpcError(null, -32600, 'Request ID must be a string or finite number.'), 400);
    if (hasId) id = message.id;
    if (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) return jsonResponse(rpcError(id, -32602, 'Parameters must be an object.'));
    const params = message.params ?? {};
    const version = request.headers.get('MCP-Protocol-Version') ?? '2025-03-26';
    if (message.method !== 'initialize' && !supportedMcpVersions.includes(version)) return jsonResponse(rpcError(id, -32000, 'Unsupported MCP protocol version.', { supported: supportedMcpVersions }), 400);
    if (!hasId) {
      // Notifications never perform project writes or invoke tools.
      return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    }
    switch (message.method) {
      case 'initialize': {
        if (typeof params.protocolVersion !== 'string' || !params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities) || typeof params.clientInfo?.name !== 'string' || typeof params.clientInfo?.version !== 'string') return jsonResponse(rpcError(id, -32602, 'initialize requires protocolVersion, capabilities and clientInfo.'));
        return jsonResponse(rpcResult(id, {
          protocolVersion: supportedMcpVersions.includes(params.protocolVersion) ? params.protocolVersion : supportedMcpVersions[0],
          capabilities: { tools: {} }, serverInfo: { name: 'turnkey-projects', version: '1.0.0' },
          instructions: 'Start with get_model_documentation. Read exact revisions and use explicit branches and expected heads for writes. Check capability limits; unsupported geometry edits require a project adapter.',
        }));
      }
      case 'ping': return jsonResponse(rpcResult(id, {}));
      case 'tools/list':
        if (params.cursor !== undefined) return jsonResponse(rpcError(id, -32602, 'This tool list is not paginated; omit cursor.'));
        return jsonResponse(rpcResult(id, { tools: service.listTools() }));
      case 'tools/call': {
        if (typeof params.name !== 'string' || (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)))) return jsonResponse(rpcError(id, -32602, 'tools/call requires a tool name and object arguments.'));
        try {
          const result = await service.execute(params.name, params.arguments ?? {}, request);
          return jsonResponse(rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { result }, isError: false }));
        } catch (error) {
          const result = projectError(error);
          // Authentication failure remains an HTTP challenge, not a successful
          // RPC result, so clients do not cache a false authenticated session.
          if (result.status === 401 || result.status === 403) return jsonResponse(rpcError(id, -32001, result.error.message, result.error), result.status, projectErrorHeaders(error));
          return jsonResponse(rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }], structuredContent: { error: result.error }, isError: true }));
        }
      }
      default: return jsonResponse(rpcError(id, -32601, 'Method not found.'));
    }
  } catch (error) {
    const result = projectError(error);
    return jsonResponse(rpcError(id, result.error.code === 'invalid_json' ? -32700 : -32000, result.error.message, result.error), result.status, projectErrorHeaders(error));
  }
}
