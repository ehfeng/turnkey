#!/usr/bin/env node
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createProjectConfig } from '../lib/project-config.mjs';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string', default: '.' }, port: { type: 'string' }, host: { type: 'string' }, help: { type:'boolean', short:'h' }
  }});
  const usage = 'Usage: turnkey <dev|build|serve-build|validate> [--project PATH] [--host HOST] [--port PORT]';
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 1 || !['dev','build','serve-build','validate'].includes(positionals[0])) throw new Error(usage);
  const root = resolve(values.project);
  if (!(await stat(root)).isDirectory()) throw new Error('Expected a project directory: ' + root);
  const command = positionals[0];
  if (command === 'validate') {
    const { validateProject } = await import('../lib/validate.mjs');
    const report = await validateProject(root);
    for (const warning of report.warnings) console.warn(warning);
    for (const error of report.errors) console.error(error);
    if (report.errors.length) process.exitCode = 1;
    return;
  }
  const { build, createServer, preview } = await import('vite');
  const config = await createProjectConfig(root);
  if (command === 'build') { await build(config); return; }
  const address = {};
  if (values.port !== undefined) {
    address.port = Number(values.port);
    if (!Number.isInteger(address.port) || address.port < 0 || address.port > 65535) throw new Error('Invalid port: ' + values.port);
  }
  if (values.host) address.host = values.host;
  const server = command === 'dev' ? await createServer({ ...config, server: { ...config.server, ...address } }) :
    await preview({ ...config, preview: { host:'localhost', ...address } });
  if (command === 'dev') await server.listen();
  server.printUrls();
  server.bindCLIShortcuts?.({ print: true });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
