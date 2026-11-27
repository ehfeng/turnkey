// The local application grants edit access only to the browser on the developer's machine.
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const loopbackPeers = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLocalDesignEditor(req) {
  if (!loopbackPeers.has(req.socket.remoteAddress)) return false;
  const host = req.headers.host;
  try {
    const site = new URL((req.socket.encrypted ? 'https://' : 'http://') + host);
    if (site.host !== host || !loopbackHosts.has(site.hostname)) return false;
    return req.headers.origin === undefined || req.headers.origin === site.origin;
  } catch { return false; }
}
