// Optional trusted driver for an already-running local Ollama daemon. Never
// started by the contract baseline; no model download, shell or credentials.
import { readFileSync } from 'node:fs';

const { configuration, instructions, request, tools, history } = JSON.parse(readFileSync(0, 'utf8'));
const response = await fetch('http://127.0.0.1:11434/api/chat', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(28000),
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: configuration, format: 'json', stream: false,
    options: { temperature: 0, seed: 7, num_predict: 512 },
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: JSON.stringify({ request, tools, history }) },
    ] }),
});
if (!response.ok) throw Error(`Loopback model returned HTTP ${response.status}`);
const chunks = [];
let length = 0;
for await (const chunk of response.body) {
  length += chunk.length;
  if (length > 64 * 1024) throw Error('Loopback model reply exceeds 64 KiB');
  chunks.push(chunk);
}
const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const decision = JSON.parse(packet.message.content);
if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw Error('Expected a JSON decision object');
delete decision.usage; // A model cannot self-assert its own metering.
if ([packet.prompt_eval_count, packet.eval_count].every(n => Number.isSafeInteger(n) && n >= 0)) {
  decision.usage = { inputTokens: packet.prompt_eval_count, outputTokens: packet.eval_count };
}
console.log(JSON.stringify(decision));
