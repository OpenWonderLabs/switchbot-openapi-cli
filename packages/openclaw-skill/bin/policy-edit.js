#!/usr/bin/env node
// packages/openclaw-skill/bin/policy-edit.js — invoked as `switchbot-policy-edit`
const { startEditorServer } = await import(new URL('../policy-editor/server.js', import.meta.url));

const server = await startEditorServer({ port: 18799 });
console.log(`Policy editor: http://localhost:${server.port}`);
const open = (await import('open').catch(() => null))?.default;
if (open) await open(`http://localhost:${server.port}`);
