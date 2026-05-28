#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src  = path.resolve(__dirname, '../skills/switchbot/SKILL.md');
const dest = path.resolve(__dirname, '../plugins/switchbot/skills/switchbot/SKILL.md');
fs.copyFileSync(src, dest);
