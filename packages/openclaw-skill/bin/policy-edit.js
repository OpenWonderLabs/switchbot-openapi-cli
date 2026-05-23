#!/usr/bin/env node
// packages/openclaw-skill/bin/policy-edit.js — invoked as `switchbot-policy-edit`
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { startEditorServer } = await import(join(__dirname, '../policy-editor/server.js'));

const server = await startEditorServer({ port: 18799 });
console.log(`Policy editor: http://localhost:${server.port}`);
const open = (await import('open').catch(() => null))?.default;
if (open) await open(`http://localhost:${server.port}`);
