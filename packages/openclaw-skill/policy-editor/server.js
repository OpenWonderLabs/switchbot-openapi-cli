// policy-editor/server.js
import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = process.env.SWITCHBOT_POLICY_PATH
  ?? path.join(process.env.HOME ?? process.env.USERPROFILE, '.config/openclaw/switchbot/policy.yaml');

export function startEditorServer({ port = 18799, dryRun = false } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else if (req.method === 'GET' && req.url === '/policy') {
      const content = fs.existsSync(POLICY_PATH)
        ? fs.readFileSync(POLICY_PATH, 'utf8')
        : '';
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } else if (req.method === 'POST' && req.url === '/policy') {
      let body = '';
      const MAX_BYTES = 512 * 1024; // 512 KB — policy.yaml should never exceed this
      req.on('data', c => {
        if (body.length + c.length > MAX_BYTES) {
          res.writeHead(413); res.end('payload too large');
          req.destroy();
          return;
        }
        body += c;
      });
      req.on('end', () => {
        if (res.headersSent) return;
        if (!dryRun) {
          fs.mkdirSync(path.dirname(POLICY_PATH), { recursive: true });
          fs.writeFileSync(POLICY_PATH, body, 'utf8');
        }
        res.writeHead(200); res.end('saved');
      });
    } else if (req.method === 'GET' && /^\/(editor\.js|style\.css)$/.test(req.url)) {
      const file = path.join(__dirname, req.url);
      const mime = req.url.endsWith('.js') ? 'application/javascript' : 'text/css';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(fs.readFileSync(file));
    } else {
      res.writeHead(404); res.end();
    }
  });

  return new Promise(resolve => {
    server.listen(dryRun ? 0 : port, '127.0.0.1', () => {
      const addr = server.address();
      server.port = addr.port;
      resolve(server);
    });
  });
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startEditorServer();
  const url = `http://localhost:${server.port}`;
  console.log(`Policy editor running at ${url}`);
  try {
    const open = (await import('open')).default;
    await open(url);
  } catch { console.log(`Open your browser: ${url}`); }
}
