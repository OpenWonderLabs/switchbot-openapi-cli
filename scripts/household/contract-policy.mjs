// A scripted consumer of the same decision input as external drivers. No
// access to fixture IDs, evaluator state, expected results or cloud ledger.
export function contractDecision({ request, history }) {
  const values = {};
  for (const profile of request.profiles) {
    const seen = history.filter(t => t.profile === profile);
    const call = (tool, args) => ({ profile, tool, arguments: args });
    const inventory = seen.find(t => t.tool === 'list_devices')?.result;
    if (!inventory) return call('list_devices', {});
    const matches = inventory.structuredContent?.deviceList?.filter(d => d.deviceName === request.target) ?? [];
    if (matches.length !== 1) return { finish: 'clarify', candidates: matches.map(d => d.deviceId) };
    const deviceId = matches[0].deviceId;
    if (request.objective === 'read-temperature') {
      const status = seen.find(t => t.tool === 'get_device_status')?.result;
      if (!status) return call('get_device_status', { deviceId });
      values[profile] = status.structuredContent?.status?.temperature;
      continue;
    }
    const sent = seen.find(t => t.tool === 'send_command')?.result;
    const preview = request.objective === 'preview-power';
    if (!sent) return call('send_command', { deviceId, command: request.command ?? 'press', ...(preview ? { dryRun: true } : {}) });
    return { finish: sent.isError ? 'unknown' : preview ? 'previewed' : 'done' };
  }
  return { finish: 'read', values };
}
