import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('blocks a release candidate whose advertised readonly tool fails and unregisters it', () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'switchbot-readonly-candidate-'));
  const peer = path.join(work, 'candidate.mjs');
  const host = path.join(work, 'openclaw');
  const registration = path.join(work, 'registered');
  const evidencePath = path.join(work, 'evidence.json');
  try {
    writeFileSync(peer, `import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('3.9.0');
else if (args[0] === 'doctor') console.log(JSON.stringify({schemaVersion:'1.2',data:{checks:[{name:'credentials',status:'ok'}]}}));
else if (args[0] === 'rules') console.log(JSON.stringify({schemaVersion:'1.2',data:{rules:[]}}));
else if (args[0] === 'mcp') {
  readline.createInterface({input:process.stdin}).on('line', line => {
    const request=JSON.parse(line);
    if (!request.id) return;
    let result;
    if (request.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'broken-published-candidate',version:'3.9.0'}};
    else if (request.method==='tools/list') result={tools:[{name:'device_diary',inputSchema:{type:'object'}},{name:'device_history',inputSchema:{type:'object'}}]};
    else if (request.method==='tools/call') result={isError:true,content:[{type:'text',text:'Readonly storage unavailable'}]};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
  });
}
`);
    writeFileSync(host, `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='--version')console.log('2026.10.2-fixture');
else if(args[1]==='install')fs.writeFileSync(${JSON.stringify(registration)},'installed');
else if(args[1]==='list')console.log(JSON.stringify({plugins:[{id:'switchbot'}]}));
else if(args[1]==='inspect')console.log(JSON.stringify({plugin:{format:'bundle',bundleFormat:'claude',status:'loaded'},mcpServers:[{name:'switchbot',hasStdioTransport:true}]}));
else if(args[1]==='uninstall')fs.rmSync(${JSON.stringify(registration)},{force:true});
`);
    chmodSync(host, 0o755);
    const result = spawnSync(process.execPath, [
      'scripts/smoke-host-runtime.mjs', '--host', 'openclaw', '--require-host', '--candidate-cli', peer, '--evidence', evidencePath,
    ], {
      env: {
        ...process.env,
        PATH: [work, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(1);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    expect(evidence.status).toBe('blocked');
    expect(evidence.hosts[0].detail).toContain('Readonly storage unavailable');
    expect(existsSync(registration)).toBe(false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
