import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const clientInstance = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  class DryRunSignal extends Error {
    constructor(public readonly method: string, public readonly url: string) {
      super('dry-run');
      this.name = 'DryRunSignal';
    }
  }
  return {
    createClient: vi.fn(() => instance),
    __instance: instance,
    DryRunSignal,
  };
});

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
  ApiError: class ApiError extends Error {
    constructor(message: string, public readonly code: number) {
      super(message);
      this.name = 'ApiError';
    }
  },
  DryRunSignal: apiMock.DryRunSignal,
}));

import { registerDevicesCommand } from '../../src/commands/devices.js';
import { runCli } from '../helpers/cli.js';
import { updateCacheFromDeviceList, resetListCache } from '../../src/devices/cache.js';

// ---- Helpers -----------------------------------------------------------
const DID = 'DEV-ID';

// v2.6.0: unknown deviceId now exits 2 by default (B-3). The top-level describe
// exercises generic command wiring for a device we deliberately *don't* seed in
// the cache — append --allow-unknown-device so those tests keep exercising the
// pass-through path. Tests that specifically assert the new strict behavior
// call runCli directly without this helper.
async function runCmd(...extra: string[]) {
  return runCli(registerDevicesCommand, [
    'devices',
    'command',
    DID,
    ...extra,
    '--allow-unknown-device',
  ]);
}

function expectPost(command: string, parameter: unknown, commandType = 'command') {
  expect(apiMock.__instance.post).toHaveBeenCalledWith(
    `/v1.1/devices/${DID}/commands`,
    { command, parameter, commandType }
  );
}

// ---- Sample data for list/status ---------------------------------------
const sampleBody = {
  deviceList: [
    {
      deviceId: 'ABC123',
      deviceName: 'Living Lamp',
      deviceType: 'Color Bulb',
      hubDeviceId: 'HUB-1',
      enableCloudService: true,
      roomID: 'R-LIVING',
      roomName: 'Living Room',
      familyName: 'Home',
      controlType: 'Light',
    },
    {
      deviceId: 'BLE-001',
      deviceName: 'Kitchen Bot',
      deviceType: 'Bot',
      hubDeviceId: '000000000000',
      enableCloudService: false,
      roomID: 'defaultRoom',
      roomName: null,
      familyName: 'Home',
      controlType: 'Bot',
    },
    {
      deviceId: 'NOHUB-1',
      deviceName: 'Strip Light',
      deviceType: 'Strip Light 3',
      hubDeviceId: '',
      enableCloudService: true,
      roomID: 'R-LIVING',
      roomName: 'Living Room',
      familyName: 'Home',
      controlType: 'Light',
    },
  ],
  infraredRemoteList: [
    {
      deviceId: 'IR-001',
      deviceName: 'TV',
      remoteType: 'TV',
      hubDeviceId: 'HUB-1',
      controlType: 'TV',
    },
  ],
};

describe('devices command', () => {
  let tmpHome: string;
  beforeEach(() => {
    // Redirect the cache dir to an ephemeral tmp path so the new 1h default
    // list-cache TTL doesn't short-circuit the mocked HTTP client using a
    // real ~/.switchbot/devices.json that might exist on the dev machine.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-devtest-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    resetListCache();
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    apiMock.createClient.mockReset();
    apiMock.createClient.mockImplementation(() => apiMock.__instance);
    apiMock.__instance.post.mockResolvedValue({ data: { body: {} } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetListCache();
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // =====================================================================
  // list
  // =====================================================================
  describe('list', () => {
    it('renders a table with physical + IR devices in default mode', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list']);
      const out = res.stdout.join('\n');
      expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/devices');
      expect(out).toContain('ABC123');
      expect(out).toContain('Living Lamp');
      // IR type shown without [IR] prefix; category column shows 'ir'
      expect(out).toContain('TV');
      expect(out).toContain('ir');
      expect(out).not.toContain('[IR]');
      expect(out).toContain('3 physical device');
      expect(out).toContain('1 IR remote');
    });

    it('accepts the "ls" alias and behaves like "list"', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'ls']);
      expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/devices');
      expect(res.stdout.join('\n')).toContain('ABC123');
    });

    it('shows family and room columns with --wide', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--wide']);
      const out = res.stdout.join('\n');
      expect(out).toContain('family');
      expect(out).toContain('room');
      expect(out).toContain('Home');
      expect(out).toContain('Living Room');
    });

    it('renders controlType column for physical and IR devices with --wide', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--wide']);
      const out = res.stdout.join('\n');
      expect(out).toContain('controlType');
      // physical row: 'Light' from controlType
      const lampRow = out.split('\n').find((l) => l.includes('ABC123'));
      expect(lampRow).toContain('Light');
      // IR row also surfaces controlType
      const tvRow = out.split('\n').find((l) => l.includes('IR-001'));
      expect(tvRow).toContain('TV');
    });

    it('renders missing controlType as em-dash with --wide', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: {
            deviceList: [
              {
                deviceId: 'NO-CTYPE',
                deviceName: 'Legacy',
                deviceType: 'Bot',
                hubDeviceId: 'HUB',
                enableCloudService: true,
              },
            ],
            infraredRemoteList: [],
          },
        },
      });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--wide']);
      const row = res.stdout.join('\n').split('\n').find((l) => l.includes('NO-CTYPE'));
      expect(row).toContain('—');
    });

    it('renders empty-string controlType and missing deviceType as em-dash with --wide', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: {
            deviceList: [
              {
                deviceId: 'AI-DEV',
                deviceName: 'AI MindClip',
                hubDeviceId: '',
                enableCloudService: true,
                familyName: 'Home',
                roomID: 'R1',
                roomName: 'Office',
                controlType: '',
              },
            ],
            infraredRemoteList: [],
          },
        },
      });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--wide']);
      const row = res.stdout.join('\n').split('\n').find((l) => l.includes('AI-DEV'));
      expect(row).toBeDefined();
      expect(row).not.toContain('undefined');
      // type column (position 3) and controlType column (position 5) should both render as em-dash
      expect(row!.match(/—/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('renders roomID column for physical devices with --wide', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--wide']);
      const out = res.stdout.join('\n');
      expect(out).toContain('roomID');
      const lampRow = out.split('\n').find((l) => l.includes('ABC123'));
      expect(lampRow).toContain('R-LIVING');
    });

    it('renders null roomName as em-dash with --wide', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: {
            deviceList: [
              {
                deviceId: 'X',
                deviceName: 'N',
                deviceType: 'T',
                hubDeviceId: 'HUB',
                enableCloudService: true,
                familyName: 'F',
                roomName: null,
              },
            ],
            infraredRemoteList: [],
          },
        },
      });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--wide']);
      expect(res.stdout.join('\n')).toContain('—');
    });

    it('renders empty-string hubDeviceId as em-dash with --wide', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: {
            deviceList: [
              {
                deviceId: 'EMPTY-HUB',
                deviceName: 'Gadget',
                deviceType: 'Strip Light 3',
                hubDeviceId: '',
                enableCloudService: true,
                familyName: 'Home',
                roomName: 'Bedroom',
              },
            ],
            infraredRemoteList: [],
          },
        },
      });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--wide']);
      const out = res.stdout.join('\n');
      expect(out).toContain('EMPTY-HUB');
      expect(out).toContain('—');
    });

    it('in --json mode, outputs raw body and skips the table', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--json']);
      const out = res.stdout.join('\n');
      expect(out).toContain('"deviceList"');
      expect(out).toContain('"infraredRemoteList"');
      expect(out).not.toContain('| deviceName');
    });

    it('prints "No devices found" when both lists are empty', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: { deviceList: [], infraredRemoteList: [] } },
      });
      const res = await runCli(registerDevicesCommand, ['devices', 'list']);
      expect(res.stdout.join('\n')).toContain('No devices found');
    });

    it('invokes handleError (exit 1) when the client throws', async () => {
      apiMock.__instance.get.mockRejectedValue(new Error('network down'));
      const res = await runCli(registerDevicesCommand, ['devices', 'list']);
      expect(res.exitCode).toBe(1);
      expect(res.stderr.join('\n')).toContain('network down');
    });

    it('IR remotes inherit family/room/roomID from their bound Hub', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: {
            deviceList: [
              {
                deviceId: 'HUB-MAIN',
                deviceName: 'Living Room Hub',
                deviceType: 'Hub 2',
                hubDeviceId: '',
                enableCloudService: true,
                familyName: 'HomeA',
                roomID: 'R-HUB-ROOM',
                roomName: 'Living Room',
              },
            ],
            infraredRemoteList: [
              {
                deviceId: 'IR-TV',
                deviceName: 'TV',
                remoteType: 'TV',
                hubDeviceId: 'HUB-MAIN',
              },
              {
                deviceId: 'IR-ORPHAN',
                deviceName: 'Orphan',
                remoteType: 'Fan',
                hubDeviceId: 'HUB-MISSING',
              },
            ],
          },
        },
      });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--wide']);
      const out = res.stdout.join('\n');
      // Row for IR-TV should show HomeA / R-HUB-ROOM / Living Room inherited from HUB-MAIN
      const irTvRow = out.split('\n').find((l) => l.includes('IR-TV'));
      expect(irTvRow).toBeDefined();
      expect(irTvRow).toContain('HomeA');
      expect(irTvRow).toContain('R-HUB-ROOM');
      expect(irTvRow).toContain('Living Room');
      // Row for IR-ORPHAN points at a missing hub → both columns fall back to —
      const orphanRow = out.split('\n').find((l) => l.includes('IR-ORPHAN'));
      expect(orphanRow).toBeDefined();
      expect(orphanRow).not.toContain('HomeA');
    });
  });

  describe('list --format', () => {
    it('--format=tsv outputs tab-separated data', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--format', 'tsv']);
      const lines = res.stdout.join('\n').split('\n');
      expect(lines[0]).toContain('deviceId\t');
      expect(lines[0]).toContain('deviceName');
      expect(lines[1]).toContain('ABC123\t');
      expect(lines[1]).toContain('Living Lamp');
    });

    it('--format=tsv --fields=deviceId,type shows only those columns', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--format', 'tsv', '--fields', 'deviceId,type']);
      const lines = res.stdout.join('\n').split('\n');
      expect(lines[0]).toBe('deviceId\ttype');
      expect(lines[1]).toContain('ABC123');
      expect(lines[1]).not.toContain('Living Lamp');
    });

    it('--fields id,name aliases resolve to deviceId/deviceName columns (bug #22)', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--format', 'tsv', '--fields', 'id,name']);
      const lines = res.stdout.join('\n').split('\n');
      // Header row must show the resolved canonical column names
      expect(lines[0]).toBe('deviceId\tdeviceName');
      // Data rows must contain the device id and name values
      expect(lines[1]).toBe('ABC123\tLiving Lamp');
    });

    it('--fields roomName resolves to the room column (API canonical alias)', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--format', 'tsv', '--fields', 'roomName']);
      const lines = res.stdout.join('\n').split('\n');
      expect(lines[0]).toBe('room');
      expect(lines).toContain('Living Room');
    });

    it('--format=id outputs one deviceId per line', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--format', 'id']);
      const lines = res.stdout.join('\n').split('\n').filter(Boolean);
      expect(lines).toContain('ABC123');
      expect(lines).toContain('BLE-001');
      expect(lines.every((l) => !l.includes('\t'))).toBe(true);
    });

    it('--format=jsonl outputs one JSON object per line', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--format', 'jsonl']);
      const lines = res.stdout.join('\n').split('\n').filter(Boolean);
      const first = JSON.parse(lines[0]);
      expect(first.deviceId).toBe('ABC123');
      expect(first.deviceName).toBe('Living Lamp');
    });

    it('--format=yaml outputs YAML documents', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--format', 'yaml']);
      const out = res.stdout.join('\n');
      expect(out).toContain('---');
      expect(out).toContain('deviceId: ABC123');
      expect(out).toContain('deviceName: Living Lamp');
    });

    it('--format=table still shows the footer summary', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--format', 'table']);
      const out = res.stdout.join('\n');
      expect(out).toContain('3 physical device');
      expect(out).toContain('1 IR remote');
    });

    it('--format=tsv suppresses the footer summary', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--format', 'tsv']);
      const out = res.stdout.join('\n');
      expect(out).not.toContain('physical device');
    });

    it('--filter category=physical shows only physical devices in table mode', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'category=physical']);
      const out = res.stdout.join('\n');
      expect(out).toContain('BLE-001');
      expect(out).not.toContain('IR-001');
    });

    it('--filter category=ir shows only IR remotes in table mode', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'category=ir']);
      const out = res.stdout.join('\n');
      expect(out).not.toContain('BLE-001');
      expect(out).toContain('IR-001');
    });

    it('--filter deviceType=Color Bulb accepts API canonical field name', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'deviceType=Color Bulb', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(1);
      expect(out.data.deviceList[0].deviceId).toBe('ABC123');
    });

    it('--filter deviceName=Kitchen accepts API canonical field name', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'deviceName=Kitchen', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(1);
      expect(out.data.deviceList[0].deviceId).toBe('BLE-001');
    });

    it('--filter deviceId=ABC123 matches by id', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'deviceId=ABC123', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(1);
      expect(out.data.deviceList[0].deviceId).toBe('ABC123');
    });

    it('--filter --json applies filter to JSON output', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'category=physical', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(3);
      expect(out.data.infraredRemoteList).toHaveLength(0);
    });

    it('--filter name~Kitchen uses substring match (bug #39)', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'name~Kitchen', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(1);
      expect(out.data.deviceList[0].deviceId).toBe('BLE-001');
    });

    it('--filter type=/regex/ uses case-insensitive regex (bug #39)', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'type=/^Strip.*/', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(1);
      expect(out.data.deviceList[0].deviceId).toBe('NOHUB-1');
    });

    it('--filter with invalid regex exits 2 with UsageError (bug #39)', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'name=/[unterminated/']);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/Invalid regex/i);
    });

    it('--filter combines AND clauses across ops (bug #39)', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'list', '--filter', 'category=physical,name~Lamp', '--json',
      ]);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(1);
      expect(out.data.deviceList[0].deviceId).toBe('ABC123');
    });

    it('--filter controlType=Bot filters by controlType', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'controlType=Bot', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(1);
      expect(out.data.deviceList[0].deviceId).toBe('BLE-001');
    });

    it('--filter roomName=Living filters by roomName (API canonical name)', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'roomName=Living', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      // ABC123 and NOHUB-1 both have roomName='Living Room'; BLE-001 has null
      expect(out.data.deviceList).toHaveLength(2);
      expect(out.data.deviceList.map((d: { deviceId: string }) => d.deviceId)).not.toContain('BLE-001');
    });

    it('--filter family=Home filters by familyName', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'family=Home', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(3);
    });

    it('--filter hub=HUB-1 filters by hubDeviceId', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'hub=HUB-1', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(1);
      expect(out.data.deviceList[0].deviceId).toBe('ABC123');
    });

    it('--filter cloud=true filters by enableCloudService', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'cloud=true', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      // ABC123 (true) and NOHUB-1 (true); BLE-001 (false) excluded
      expect(out.data.deviceList).toHaveLength(2);
      expect(out.data.deviceList.map((d: { deviceId: string }) => d.deviceId)).not.toContain('BLE-001');
    });

    it('--filter roomID=R-LIVING filters by roomID', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'list', '--filter', 'roomID=R-LIVING', '--json']);
      const out = JSON.parse(res.stdout.join('\n'));
      expect(out.data.deviceList).toHaveLength(2);
      expect(out.data.deviceList.map((d: { deviceId: string }) => d.deviceId)).not.toContain('BLE-001');
    });
  });

  // =====================================================================
  // status
  // =====================================================================
  describe('status', () => {
    it('key-value prints every field in the response body', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: { power: 'on', battery: 87 } },
      });
      const res = await runCli(registerDevicesCommand, ['devices', 'status', 'ABC']);
      expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/devices/ABC/status');
      const out = res.stdout.join('\n');
      expect(out).toContain('power');
      expect(out).toContain('on');
      expect(out).toContain('battery');
      expect(out).toContain('87');
    });

    it('in --json mode, outputs the raw body as JSON', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: { power: 'off' } },
      });
      const res = await runCli(registerDevicesCommand, ['devices', 'status', 'XYZ', '--json']);
      expect(res.stdout.join('\n')).toContain('"power"');
    });

    it('exits 1 when the API throws', async () => {
      apiMock.__instance.get.mockRejectedValue(new Error('device offline'));
      const res = await runCli(registerDevicesCommand, ['devices', 'status', 'BLE']);
      expect(res.exitCode).toBe(1);
      expect(res.stderr.join('\n')).toContain('device offline');
    });

    it('supports --format=tsv', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: { power: 'on', battery: 87, temperature: 22 } },
      });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'status', 'ABC', '--format', 'tsv',
      ]);
      const out = res.stdout.join('\n');
      expect(out).toContain('power\tbattery\ttemperature');
      expect(out).toContain('on\t87\t22');
    });

    it('exits 2 for --format id (status has no deviceId column)', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: { power: 'on', battery: 87 } },
      });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'status', 'DEV123', '--format', 'id',
      ]);
      expect(res.exitCode).toBe(2);
    });

    it('supports --format json (array of objects)', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: { power: 'off', battery: 50 } },
      });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'status', 'ABC', '--format', 'json',
      ]);
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(Array.isArray(parsed.data)).toBe(true);
      // _fetchedAt is added by the CLI; verify other fields are present
      expect(parsed.data[0].power).toBe('off');
      expect(parsed.data[0].battery).toBe(50);
      expect(parsed.data[0]._fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('serializes nested objects to JSON strings in tsv output', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: {
            power: 'on',
            calibration: { min: 0, max: 100 },
            tags: ['living', 'main'],
            battery: 90,
          },
        },
      });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'status', 'DEV1', '--format', 'tsv',
      ]);
      const lines = res.stdout.join('\n').split('\n');
      // Headers
      expect(lines[0]).toContain('calibration');
      expect(lines[0]).toContain('tags');
      // Values: nested object and array are JSON-stringified
      expect(lines[1]).toContain('{"min":0,"max":100}');
      expect(lines[1]).toContain('["living","main"]');
    });

    it('preserves nested objects as real values in --format json', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: {
            power: 'on',
            motion: { x: 1, y: 2 },
            modes: ['eco', 'turbo'],
          },
        },
      });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'status', 'DEV2', '--format', 'json',
      ]);
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data[0].power).toBe('on');
      // Nested object/array fields come through as real JS values.
      expect(parsed.data[0].motion).toEqual({ x: 1, y: 2 });
      expect(parsed.data[0].modes).toEqual(['eco', 'turbo']);
    });

    it('null status fields appear as empty string in tsv', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: { power: 'on', battery: null } },
      });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'status', 'DEV3', '--format', 'tsv',
      ]);
      const lines = res.stdout.join('\n').split('\n');
      // null maps to empty string in cellToString; _fetchedAt column is also present
      expect(lines[1]).toMatch(/^on\t\t/);
    });
  });

  // =====================================================================
  // command — generic behavior (parameter parsing, flags, error paths)
  // =====================================================================
  describe('command — generic behavior', () => {
    it('defaults parameter to "default" and commandType to "command" when none given', async () => {
      await runCmd('turnOn');
      expectPost('turnOn', 'default');
    });

    it('passes plain-string parameter through unchanged', async () => {
      await runCmd('setColor', '255:0:0');
      expectPost('setColor', '255:0:0');
    });

    it('parses JSON-object parameter into an object', async () => {
      await runCmd('startClean', '{"action":"sweep","param":{"fanLevel":2}}');
      expectPost('startClean', { action: 'sweep', param: { fanLevel: 2 } });
    });

    it('keeps malformed JSON parameter as a plain string (no throw)', async () => {
      await runCmd('setAll', 'not json {');
      expectPost('setAll', 'not json {');
    });

    it('passes --type customize through as commandType', async () => {
      await runCmd('MyButton', '--type', 'customize');
      expectPost('MyButton', 'default', 'customize');
    });

    it('prints a success line in default output mode', async () => {
      const res = await runCmd('turnOn');
      expect(res.stdout.join('\n')).toContain('Command sent: turnOn');
    });

    it('prints key-value extras when response body has fields', async () => {
      apiMock.__instance.post.mockResolvedValue({
        data: { body: { commandId: 'cmd-xyz' } },
      });
      const res = await runCmd('turnOn');
      const out = res.stdout.join('\n');
      expect(out).toContain('commandId');
      expect(out).toContain('cmd-xyz');
    });

    it('does not try to print key-value when body is empty', async () => {
      const res = await runCmd('turnOn');
      expect(res.stdout.length).toBe(1);
    });

    it('in --json mode, outputs raw body and skips success line', async () => {
      apiMock.__instance.post.mockResolvedValue({
        data: { body: { commandId: 'cmd-json' } },
      });
      const res = await runCmd('turnOn', '--json');
      const out = res.stdout.join('\n');
      expect(out).toContain('"commandId": "cmd-json"');
      expect(out).not.toContain('Command sent');
    });

    it('exits 1 when the API throws (e.g. 161 device offline)', async () => {
      apiMock.__instance.post.mockRejectedValue(
        new Error('Device offline (check Wi-Fi / Bluetooth connection)')
      );
      const res = await runCmd('turnOn');
      expect(res.exitCode).toBe(1);
      expect(res.stderr.join('\n')).toContain('Device offline');
    });

    it('exits 2 when deviceId is not in the local cache (B-3, 2.6.0)', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', DID, 'turnOn',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/not in local cache/i);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('passes through with a soft note when --allow-unknown-device is set', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', DID, 'turnOn', '--allow-unknown-device',
      ]);
      expect(res.exitCode).toBeNull();
      expect(res.stderr.join('\n')).toMatch(
        /not in the local cache.*switchbot devices list/i,
      );
      expect(apiMock.__instance.post).toHaveBeenCalled();
    });

    it('does not print the cache-miss hint when the device is in the local cache', async () => {
      updateCacheFromDeviceList({
        deviceList: [
          { deviceId: DID, deviceName: 'Cached Bot', deviceType: 'Bot', hubDeviceId: 'HUB-1', enableCloudService: true },
        ],
        infraredRemoteList: [],
      });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', DID, 'turnOn',
      ]);
      expect(res.stderr.join('\n')).not.toMatch(/not in the local cache/i);
    });
  });

  // =====================================================================
  // Physical devices — by type
  // =====================================================================

  describe('device: Bot', () => {
    it('turnOn', async () => {
      await runCmd('turnOn');
      expectPost('turnOn', 'default');
    });
    it('turnOff', async () => {
      await runCmd('turnOff');
      expectPost('turnOff', 'default');
    });
    it('press', async () => {
      await runCmd('press');
      expectPost('press', 'default');
    });
  });

  describe('device: Curtain / Curtain 3', () => {
    it('turnOn opens the curtain', async () => {
      await runCmd('turnOn');
      expectPost('turnOn', 'default');
    });
    it('turnOff closes the curtain', async () => {
      await runCmd('turnOff');
      expectPost('turnOff', 'default');
    });
    it('pause', async () => {
      await runCmd('pause');
      expectPost('pause', 'default');
    });
    it('setPosition with "index,mode,position" string', async () => {
      await runCmd('setPosition', '0,ff,80');
      expectPost('setPosition', '0,ff,80');
    });
  });

  describe('device: Lock / Lock Pro / Lock Ultra', () => {
    it('lock', async () => {
      await runCmd('lock');
      expectPost('lock', 'default');
    });
    it('unlock', async () => {
      await runCmd('unlock');
      expectPost('unlock', 'default');
    });
    it('deadbolt (release latch)', async () => {
      await runCmd('deadbolt');
      expectPost('deadbolt', 'default');
    });
  });

  describe('device: Lock Lite', () => {
    it('lock', async () => {
      await runCmd('lock');
      expectPost('lock', 'default');
    });
    it('unlock', async () => {
      await runCmd('unlock');
      expectPost('unlock', 'default');
    });
  });

  describe('device: Plug / Plug Mini', () => {
    it('turnOn', async () => {
      await runCmd('turnOn');
      expectPost('turnOn', 'default');
    });
    it('turnOff', async () => {
      await runCmd('turnOff');
      expectPost('turnOff', 'default');
    });
    it('toggle (Plug Mini)', async () => {
      await runCmd('toggle');
      expectPost('toggle', 'default');
    });
  });

  describe('device: Relay Switch 1 / 1PM', () => {
    it('turnOn', async () => {
      await runCmd('turnOn');
      expectPost('turnOn', 'default');
    });
    it('turnOff', async () => {
      await runCmd('turnOff');
      expectPost('turnOff', 'default');
    });
    it('toggle', async () => {
      await runCmd('toggle');
      expectPost('toggle', 'default');
    });
    it('setMode 0 (toggle)', async () => {
      await runCmd('setMode', '0');
      expectPost('setMode', 0);
    });
    it('setMode 3 (momentary)', async () => {
      await runCmd('setMode', '3');
      expectPost('setMode', 3);
    });
  });

  describe('device: Relay Switch 2PM (dual-channel)', () => {
    it('turnOn channel 1', async () => {
      await runCmd('turnOn', '1');
      expectPost('turnOn', 1);
    });
    it('turnOff channel 2', async () => {
      await runCmd('turnOff', '2');
      expectPost('turnOff', 2);
    });
    it('toggle channel 1', async () => {
      await runCmd('toggle', '1');
      expectPost('toggle', 1);
    });
    it('setMode "1;0" (channel;mode)', async () => {
      await runCmd('setMode', '1;0');
      expectPost('setMode', '1;0');
    });
    it('setPosition 50 (roller percent)', async () => {
      await runCmd('setPosition', '50');
      expectPost('setPosition', 50);
    });
  });

  describe('device: Humidifier', () => {
    it('turnOn', async () => {
      await runCmd('turnOn');
      expectPost('turnOn', 'default');
    });
    it('setMode auto', async () => {
      await runCmd('setMode', 'auto');
      expectPost('setMode', 'auto');
    });
    it('setMode preset 101 (34%)', async () => {
      await runCmd('setMode', '101');
      expectPost('setMode', 101);
    });
    it('setMode preset 103 (100%)', async () => {
      await runCmd('setMode', '103');
      expectPost('setMode', 103);
    });
    it('setMode with custom humidity 55', async () => {
      await runCmd('setMode', '55');
      expectPost('setMode', 55);
    });
  });

  describe('device: Evaporative Humidifier', () => {
    it('setMode with JSON object {mode, targetHumidify}', async () => {
      await runCmd('setMode', '{"mode":7,"targetHumidify":50}');
      expectPost('setMode', { mode: 7, targetHumidify: 50 });
    });
    it('setChildLock true', async () => {
      await runCmd('setChildLock', 'true');
      expectPost('setChildLock', true);
    });
    it('setChildLock false', async () => {
      await runCmd('setChildLock', 'false');
      expectPost('setChildLock', false);
    });
  });

  describe('device: Air Purifier VOC / PM2.5', () => {
    it('setMode JSON with mode + fanGear', async () => {
      await runCmd('setMode', '{"mode":2,"fanGear":3}');
      expectPost('setMode', { mode: 2, fanGear: 3 });
    });
    it('setChildLock "1"', async () => {
      await runCmd('setChildLock', '1');
      expectPost('setChildLock', 1);
    });
  });

  describe('device: Color Bulb', () => {
    it('turnOn', async () => {
      await runCmd('turnOn');
      expectPost('turnOn', 'default');
    });
    it('toggle', async () => {
      await runCmd('toggle');
      expectPost('toggle', 'default');
    });
    it('setBrightness mid-range', async () => {
      await runCmd('setBrightness', '75');
      expectPost('setBrightness', 75);
    });
    it('setColor R:G:B', async () => {
      await runCmd('setColor', '122:80:20');
      expectPost('setColor', '122:80:20');
    });
    it('setColorTemperature 2700', async () => {
      await runCmd('setColorTemperature', '2700');
      expectPost('setColorTemperature', 2700);
    });
    it('setColorTemperature 6500', async () => {
      await runCmd('setColorTemperature', '6500');
      expectPost('setColorTemperature', 6500);
    });
  });

  describe('device: Strip Light', () => {
    it('setBrightness', async () => {
      await runCmd('setBrightness', '30');
      expectPost('setBrightness', 30);
    });
    it('setColor', async () => {
      await runCmd('setColor', '0:255:0');
      expectPost('setColor', '0:255:0');
    });
  });

  describe('device: Ceiling Light / Ceiling Light Pro', () => {
    it('setBrightness 1 (min)', async () => {
      await runCmd('setBrightness', '1');
      expectPost('setBrightness', 1);
    });
    it('setBrightness 100 (max)', async () => {
      await runCmd('setBrightness', '100');
      expectPost('setBrightness', 100);
    });
    it('setBrightness -1 (negative positional parameter reaches validation)', async () => {
      // Regression for bug #53: Commander used to swallow "-1" as an unknown
      // option token. With allowUnknownOption on the `command` subcommand
      // negative numbers are now treated as the parameter positional and
      // reach the API (the device then returns 190 for out-of-range values,
      // but that's a device-layer concern, not a CLI parsing failure).
      await runCmd('setBrightness', '-1');
      expectPost('setBrightness', -1);
    });
    it('setColorTemperature', async () => {
      await runCmd('setColorTemperature', '4000');
      expectPost('setColorTemperature', 4000);
    });
  });

  describe('device: Smart Radiator Thermostat', () => {
    it('turnOn / turnOff', async () => {
      await runCmd('turnOff');
      expectPost('turnOff', 'default');
    });
    it('setMode 4 (comfort)', async () => {
      await runCmd('setMode', '4');
      expectPost('setMode', 4);
    });
    it('setManualModeTemperature 22', async () => {
      await runCmd('setManualModeTemperature', '22');
      expectPost('setManualModeTemperature', 22);
    });
  });

  describe('device: Robot Vacuum S1 / S1 Plus / K10+', () => {
    it('start', async () => {
      await runCmd('start');
      expectPost('start', 'default');
    });
    it('stop', async () => {
      await runCmd('stop');
      expectPost('stop', 'default');
    });
    it('dock (return to charging)', async () => {
      await runCmd('dock');
      expectPost('dock', 'default');
    });
    it('PowLevel 3 (max suction)', async () => {
      await runCmd('PowLevel', '3');
      expectPost('PowLevel', 3);
    });
  });

  describe('device: Robot Vacuum K10+ Pro Combo / K20+ Pro', () => {
    it('startClean JSON with sweep action', async () => {
      await runCmd('startClean', '{"action":"sweep","param":{"fanLevel":2,"times":1}}');
      expectPost('startClean', {
        action: 'sweep',
        param: { fanLevel: 2, times: 1 },
      });
    });
    it('startClean JSON with mop action', async () => {
      await runCmd('startClean', '{"action":"mop","param":{"fanLevel":4,"times":2}}');
      expectPost('startClean', {
        action: 'mop',
        param: { fanLevel: 4, times: 2 },
      });
    });
    it('pause', async () => {
      await runCmd('pause');
      expectPost('pause', 'default');
    });
    it('setVolume', async () => {
      await runCmd('setVolume', '60');
      expectPost('setVolume', 60);
    });
    it('changeParam', async () => {
      await runCmd('changeParam', '{"fanLevel":3,"waterLevel":2,"times":1}');
      expectPost('changeParam', { fanLevel: 3, waterLevel: 2, times: 1 });
    });
  });

  describe('device: Floor Cleaning Robot S10 / S20', () => {
    it('startClean with sweep_mop action', async () => {
      await runCmd(
        'startClean',
        '{"action":"sweep_mop","param":{"fanLevel":3,"waterLevel":2,"times":1}}'
      );
      expectPost('startClean', {
        action: 'sweep_mop',
        param: { fanLevel: 3, waterLevel: 2, times: 1 },
      });
    });
    it('addWaterForHumi', async () => {
      await runCmd('addWaterForHumi');
      expectPost('addWaterForHumi', 'default');
    });
    it('selfClean 1 (wash mop)', async () => {
      await runCmd('selfClean', '1');
      expectPost('selfClean', 1);
    });
    it('selfClean 2 (dry)', async () => {
      await runCmd('selfClean', '2');
      expectPost('selfClean', 2);
    });
    it('selfClean 3 (terminate)', async () => {
      await runCmd('selfClean', '3');
      expectPost('selfClean', 3);
    });
  });

  describe('device: Battery Circulator Fan / Circulator Fan', () => {
    it('setNightLightMode off', async () => {
      await runCmd('setNightLightMode', 'off');
      expectPost('setNightLightMode', 'off');
    });
    it('setWindMode natural', async () => {
      await runCmd('setWindMode', 'natural');
      expectPost('setWindMode', 'natural');
    });
    it('setWindMode baby', async () => {
      await runCmd('setWindMode', 'baby');
      expectPost('setWindMode', 'baby');
    });
    it('setWindSpeed 50', async () => {
      await runCmd('setWindSpeed', '50');
      expectPost('setWindSpeed', 50);
    });
    it('closeDelay 600 (seconds)', async () => {
      await runCmd('closeDelay', '600');
      expectPost('closeDelay', 600);
    });
  });

  describe('device: Blind Tilt', () => {
    it('setPosition up;60', async () => {
      await runCmd('setPosition', 'up;60');
      expectPost('setPosition', 'up;60');
    });
    it('setPosition down;40', async () => {
      await runCmd('setPosition', 'down;40');
      expectPost('setPosition', 'down;40');
    });
    it('fullyOpen', async () => {
      await runCmd('fullyOpen');
      expectPost('fullyOpen', 'default');
    });
    it('closeUp', async () => {
      await runCmd('closeUp');
      expectPost('closeUp', 'default');
    });
    it('closeDown', async () => {
      await runCmd('closeDown');
      expectPost('closeDown', 'default');
    });
  });

  describe('device: Roller Shade', () => {
    it('setPosition 0 (open)', async () => {
      await runCmd('setPosition', '0');
      expectPost('setPosition', 0);
    });
    it('setPosition 100 (closed)', async () => {
      await runCmd('setPosition', '100');
      expectPost('setPosition', 100);
    });
  });

  describe('device: Garage Door Opener', () => {
    it('turnOn (open)', async () => {
      await runCmd('turnOn');
      expectPost('turnOn', 'default');
    });
    it('turnOff (close)', async () => {
      await runCmd('turnOff');
      expectPost('turnOff', 'default');
    });
  });

  describe('device: Video Doorbell', () => {
    it('enableMotionDetection', async () => {
      await runCmd('enableMotionDetection');
      expectPost('enableMotionDetection', 'default');
    });
    it('disableMotionDetection', async () => {
      await runCmd('disableMotionDetection');
      expectPost('disableMotionDetection', 'default');
    });
  });

  describe('device: Keypad / Keypad Touch', () => {
    it('createKey with JSON object (permanent)', async () => {
      await runCmd(
        'createKey',
        '{"name":"Guest","type":"permanent","password":"12345678"}'
      );
      expectPost('createKey', {
        name: 'Guest',
        type: 'permanent',
        password: '12345678',
      });
    });
    it('createKey timeLimit with start/end timestamps', async () => {
      await runCmd(
        'createKey',
        '{"name":"Temp","type":"timeLimit","password":"87654321","startTime":1700000000,"endTime":1700600000}'
      );
      expectPost('createKey', {
        name: 'Temp',
        type: 'timeLimit',
        password: '87654321',
        startTime: 1700000000,
        endTime: 1700600000,
      });
    });
    it('deleteKey with JSON id', async () => {
      await runCmd('deleteKey', '{"id":42}');
      expectPost('deleteKey', { id: 42 });
    });
  });

  describe('device: Candle Warmer Lamp', () => {
    it('turnOn / toggle / setBrightness / setColorTemperature', async () => {
      await runCmd('setBrightness', '80');
      expectPost('setBrightness', 80);
    });
  });

  // =====================================================================
  // Virtual IR remotes — by device class
  // =====================================================================

  describe('IR remote: common (all types)', () => {
    it('turnOn', async () => {
      await runCmd('turnOn');
      expectPost('turnOn', 'default');
    });
    it('turnOff', async () => {
      await runCmd('turnOff');
      expectPost('turnOff', 'default');
    });
  });

  describe('IR remote: Air Conditioner', () => {
    it('setAll "temperature,mode,fanSpeed,power" (cool 26°C, mid fan, on)', async () => {
      await runCmd('setAll', '26,2,3,on');
      expectPost('setAll', '26,2,3,on');
    });
    it('setAll for heat mode', async () => {
      await runCmd('setAll', '22,5,2,on');
      expectPost('setAll', '22,5,2,on');
    });
    it('setAll off', async () => {
      await runCmd('setAll', '26,1,3,off');
      expectPost('setAll', '26,1,3,off');
    });
  });

  describe('IR remote: TV / IPTV / Set Top Box', () => {
    it('SetChannel', async () => {
      await runCmd('SetChannel', '15');
      expectPost('SetChannel', 15);
    });
    it('volumeAdd', async () => {
      await runCmd('volumeAdd');
      expectPost('volumeAdd', 'default');
    });
    it('volumeSub', async () => {
      await runCmd('volumeSub');
      expectPost('volumeSub', 'default');
    });
    it('channelAdd', async () => {
      await runCmd('channelAdd');
      expectPost('channelAdd', 'default');
    });
    it('channelSub', async () => {
      await runCmd('channelSub');
      expectPost('channelSub', 'default');
    });
  });

  describe('IR remote: DVD / Speaker', () => {
    it('setMute', async () => {
      await runCmd('setMute');
      expectPost('setMute', 'default');
    });
    it('FastForward', async () => {
      await runCmd('FastForward');
      expectPost('FastForward', 'default');
    });
    it('Rewind', async () => {
      await runCmd('Rewind');
      expectPost('Rewind', 'default');
    });
    it('Next', async () => {
      await runCmd('Next');
      expectPost('Next', 'default');
    });
    it('Previous', async () => {
      await runCmd('Previous');
      expectPost('Previous', 'default');
    });
    it('Pause', async () => {
      await runCmd('Pause');
      expectPost('Pause', 'default');
    });
    it('Play', async () => {
      await runCmd('Play');
      expectPost('Play', 'default');
    });
    it('Stop', async () => {
      await runCmd('Stop');
      expectPost('Stop', 'default');
    });
  });

  describe('IR remote: Fan', () => {
    it('swing', async () => {
      await runCmd('swing');
      expectPost('swing', 'default');
    });
    it('timer', async () => {
      await runCmd('timer');
      expectPost('timer', 'default');
    });
    it('lowSpeed / middleSpeed / highSpeed', async () => {
      await runCmd('highSpeed');
      expectPost('highSpeed', 'default');
    });
  });

  describe('IR remote: Light', () => {
    it('brightnessUp', async () => {
      await runCmd('brightnessUp');
      expectPost('brightnessUp', 'default');
    });
    it('brightnessDown', async () => {
      await runCmd('brightnessDown');
      expectPost('brightnessDown', 'default');
    });
  });

  describe('IR remote: Others (custom button)', () => {
    it('sends custom button name with commandType=customize', async () => {
      await runCmd('NightMode', '--type', 'customize');
      expectPost('NightMode', 'default', 'customize');
    });
    it('custom button with a plain-string parameter and customize type', async () => {
      await runCmd('MyScene', 'extra', '--type', 'customize');
      expectPost('MyScene', 'extra', 'customize');
    });
  });

  // =====================================================================
  // devices types / commands — offline catalog lookups (no API calls)
  // =====================================================================

  describe('types (catalog listing)', () => {
    it('prints a table of known device types', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'types']);
      const out = res.stdout.join('\n');
      expect(out).toContain('Bot');
      expect(out).toContain('Curtain');
      expect(out).toContain('Air Conditioner');
      expect(out).toMatch(/Total: \d+ device type/);
      expect(apiMock.__instance.get).not.toHaveBeenCalled();
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('with --json, outputs the raw catalog array', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'types', '--json']);
      const out = res.stdout.join('\n');
      expect(out).toContain('"type"');
      expect(out).toContain('"category"');
      expect(out).toContain('"Bot"');
    });

    it('--format=tsv outputs tab-separated catalog rows', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'types', '--format', 'tsv']);
      const lines = res.stdout.join('\n').split('\n');
      expect(lines[0]).toBe('type\trole\tcategory\tcommands\taliases');
      expect(lines.find((l) => l.startsWith('Bot\t'))).toBeDefined();
    });

    it('--format=id exits 2 (types has no deviceId column)', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'types', '--format', 'id']);
      expect(res.exitCode).toBe(2);
    });
  });

  describe('commands <type> (catalog lookup)', () => {
    it('prints commands and status fields for an exact match', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'commands', 'Bot']);
      const out = res.stdout.join('\n');
      expect(out).toContain('Type:');
      expect(out).toContain('Bot');
      expect(out).toContain('turnOn');
      expect(out).toContain('press');
      expect(out).toContain('Status fields');
      expect(out).toContain('battery');
    });

    it('matches aliases', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'commands', 'Curtain 3']);
      const out = res.stdout.join('\n');
      expect(out).toContain('Type:');
      expect(out).toContain('Curtain');
      expect(out).toContain('setPosition');
    });

    it('matches case-insensitively and by substring', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'commands', 'blind']);
      expect(res.stdout.join('\n')).toContain('Blind Tilt');
    });

    it('accepts multi-word type without quoting (variadic joining)', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'commands', 'Air', 'Conditioner']);
      const out = res.stdout.join('\n');
      expect(res.stderr.join('\n')).toBe('');
      expect(out).toContain('Type:');
      expect(out).toContain('Air Conditioner');
      expect(out).toContain('setAll');
    });

    it('accepts quoted multi-word type (single argument form still works)', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'commands', 'Smart Lock']);
      const out = res.stdout.join('\n');
      expect(out).toContain('Smart Lock');
      expect(out).toContain('lock');
      expect(out).toContain('unlock');
    });

    it('lists disambiguation when the query matches multiple types', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'commands', 'Robot']);
      expect(res.exitCode).toBe(2);
      const err = res.stderr.join('\n');
      expect(err).toContain('matches multiple types');
      expect(err).toContain('Robot Vacuum Cleaner S1');
    });

    it('exits 2 with guidance when the type is unknown', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'commands', 'Nonexistent']);
      expect(res.exitCode).toBe(2);
      const err = res.stderr.join('\n');
      expect(err).toContain('No device type matches');
      expect(err).toContain('switchbot devices types');
    });

    it('notes "status-only" devices with no commands', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'commands', 'Motion Sensor']);
      const out = res.stdout.join('\n');
      expect(out).toContain('status-only');
      expect(out).toContain('moveDetected');
    });

    it('--json mode outputs the catalog entry as JSON', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'commands', 'Bot', '--json']);
      const out = res.stdout.join('\n');
      expect(out).toContain('"type": "Bot"');
      expect(out).toContain('"commands"');
    });

    it('fails when <type> is missing (commander error)', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'commands']);
      expect(res.stderr.join('\n').toLowerCase()).toContain('missing required');
    });
  });

  describe('describe <deviceId>', () => {
    it('prints metadata + catalog entry for a physical device in the catalog', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'BLE-001']);

      expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/devices');
      expect(apiMock.__instance.get).toHaveBeenCalledTimes(1);

      const out = res.stdout.join('\n');
      // metadata
      expect(out).toContain('BLE-001');
      expect(out).toContain('Kitchen Bot');
      expect(out).toContain('Bot');
      // catalog
      expect(out).toContain('turnOn');
      expect(out).toContain('press');
      expect(out).toContain('Status fields');
    });

    it('prints metadata + catalog for an IR remote with known remoteType', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'IR-001']);
      const out = res.stdout.join('\n');
      expect(out).toContain('IR-001');
      expect(out).toContain('remoteType');
      expect(out).toContain('TV');
      expect(out).toContain('SetChannel');
    });

    it('IR remote inherits family/room from its bound Hub in describe output', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: {
            deviceList: [
              {
                deviceId: 'HUB-LR',
                deviceName: 'Living Hub',
                deviceType: 'Hub 2',
                hubDeviceId: '',
                enableCloudService: true,
                familyName: 'MyHome',
                roomName: 'Living Room',
              },
            ],
            infraredRemoteList: [
              { deviceId: 'IR-Z', deviceName: 'Fan', remoteType: 'Fan', hubDeviceId: 'HUB-LR' },
            ],
          },
        },
      });
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'IR-Z']);
      const out = res.stdout.join('\n');
      expect(out).toContain('MyHome');
      expect(out).toContain('Living Room');
    });

    it('shows metadata + status hint when the physical deviceType is not in the catalog', async () => {
      const body = {
        deviceList: [{
          deviceId: 'FB-X',
          deviceName: 'Fingerbot',
          deviceType: 'Fingerbot Plus',
          hubDeviceId: '',
          enableCloudService: true,
        }],
        infraredRemoteList: [],
      };
      apiMock.__instance.get.mockResolvedValue({ data: { body } });
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'FB-X']);
      const out = res.stdout.join('\n');
      expect(out).toContain('Fingerbot Plus');
      expect(out).toContain('not in the built-in catalog');
      // Physical unknown → recommend 'devices status', not --type customize.
      expect(out).toContain('switchbot devices status FB-X');
      expect(out).not.toContain('--type customize');
    });

    it('shows metadata + customize hint when an IR remoteType is not in the catalog', async () => {
      const body = {
        deviceList: [],
        infraredRemoteList: [{
          deviceId: 'IR-ODD',
          deviceName: 'Game Console',
          remoteType: 'UnknownRemote',
          hubDeviceId: 'HUB-1',
        }],
      };
      apiMock.__instance.get.mockResolvedValue({ data: { body } });
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'IR-ODD']);
      const out = res.stdout.join('\n');
      expect(out).toContain('UnknownRemote');
      expect(out).toContain('not in the built-in catalog');
      expect(out).toContain('--type customize');
    });

    it('exits 1 with guidance when the deviceId is unknown', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'UNKNOWN-ID']);
      expect(res.exitCode).toBe(1);
      const err = res.stderr.join('\n');
      expect(err).toContain('No device with id "UNKNOWN-ID"');
      expect(err).toContain('switchbot devices list');
    });

    it('--json mode outputs {device, controlType, catalog}', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'BLE-001', '--json']);
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data).toHaveProperty('device');
      expect(parsed.data).toHaveProperty('controlType', 'Bot');
      expect(parsed.data).toHaveProperty('catalog');
      expect(parsed.data.catalog.type).toBe('Bot');
      expect(parsed.data).not.toHaveProperty('category');
    });

    it('--json for IR remote surfaces controlType from the device', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'IR-001', '--json']);
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data).toHaveProperty('controlType', 'TV');
      expect(parsed.data).not.toHaveProperty('category');
    });

    it('--json includes capabilities, source=catalog, and suggestedActions', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, [
        'devices',
        'describe',
        'BLE-001',
        '--json',
      ]);
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data.source).toBe('catalog');
      expect(parsed.data.capabilities).toBeDefined();
      expect(parsed.data.capabilities.role).toBe('other');
      expect(parsed.data.capabilities.readOnly).toBe(false);
      expect(Array.isArray(parsed.data.capabilities.commands)).toBe(true);
      expect(parsed.data.capabilities.statusFields).toContain('battery');
      expect(Array.isArray(parsed.data.suggestedActions)).toBe(true);
      // turnOn is the first idempotent pick for a Bot
      expect(parsed.data.suggestedActions[0].command).toBe('turnOn');
    });

    it('--json for a Smart Lock surfaces destructive flag on unlock', async () => {
      const lockBody = {
        deviceList: [{
          deviceId: 'LOCK-1',
          deviceName: 'Front Door',
          deviceType: 'Smart Lock',
          hubDeviceId: 'HUB-1',
          enableCloudService: true,
        }],
        infraredRemoteList: [],
      };
      apiMock.__instance.get.mockResolvedValue({ data: { body: lockBody } });
      const res = await runCli(registerDevicesCommand, [
        'devices',
        'describe',
        'LOCK-1',
        '--json',
      ]);
      const parsed = JSON.parse(res.stdout.join('\n'));
      const unlock = parsed.data.capabilities.commands.find(
        (c: { command: string }) => c.command === 'unlock'
      );
      expect(unlock).toBeDefined();
      expect(unlock.destructive).toBe(true);
      expect(unlock.idempotent).toBe(true);
      // suggestedActions must NOT include the destructive unlock
      expect(
        parsed.data.suggestedActions.find((a: { command: string }) => a.command === 'unlock')
      ).toBeUndefined();
    });

    it('human output marks destructive commands in the command table', async () => {
      const lockBody = {
        deviceList: [{
          deviceId: 'LOCK-1',
          deviceName: 'Front Door',
          deviceType: 'Smart Lock',
          hubDeviceId: 'HUB-1',
          enableCloudService: true,
        }],
        infraredRemoteList: [],
      };
      apiMock.__instance.get.mockResolvedValue({ data: { body: lockBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'LOCK-1']);
      const out = res.stdout.join('\n');
      expect(out).toContain('Role:');
      expect(out).toContain('security');
      // The unlock row should carry the destructive badge
      const unlockLine = out.split('\n').find((l) => l.includes('unlock'));
      expect(unlockLine).toContain('!destructive');
      expect(out).toContain('hard-to-reverse');
    });

    it('human output shows ReadOnly for sensor devices', async () => {
      const meterBody = {
        deviceList: [{
          deviceId: 'METER-1',
          deviceName: 'Bedroom Meter',
          deviceType: 'Meter',
          hubDeviceId: 'HUB-1',
          enableCloudService: true,
        }],
        infraredRemoteList: [],
      };
      apiMock.__instance.get.mockResolvedValue({ data: { body: meterBody } });
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'METER-1']);
      const out = res.stdout.join('\n');
      expect(out).toContain('ReadOnly: yes');
      expect(out).toContain('status-only device');
    });

    it('--live fetches /status and merges it under capabilities.liveStatus', async () => {
      apiMock.__instance.get
        .mockResolvedValueOnce({ data: { body: sampleBody } })
        .mockResolvedValueOnce({ data: { body: { power: 'on', battery: 87 } } });
      const res = await runCli(registerDevicesCommand, [
        'devices',
        'describe',
        'BLE-001',
        '--live',
        '--json',
      ]);
      expect(apiMock.__instance.get).toHaveBeenCalledTimes(2);
      expect(apiMock.__instance.get).toHaveBeenNthCalledWith(1, '/v1.1/devices');
      expect(apiMock.__instance.get).toHaveBeenNthCalledWith(2, '/v1.1/devices/BLE-001/status');
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data.source).toBe('catalog+live');
      expect(parsed.data.capabilities.liveStatus).toEqual({ power: 'on', battery: 87 });
    });

    it('--live on an IR remote does NOT make a second API call (IR has no status)', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: sampleBody } });
      const res = await runCli(registerDevicesCommand, [
        'devices',
        'describe',
        'IR-001',
        '--live',
        '--json',
      ]);
      expect(apiMock.__instance.get).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data.source).toBe('catalog');
      expect(parsed.data.capabilities.liveStatus).toBeUndefined();
    });

    it('--live survives a /status failure (records the error)', async () => {
      apiMock.__instance.get
        .mockResolvedValueOnce({ data: { body: sampleBody } })
        .mockRejectedValueOnce(new Error('device offline'));
      const res = await runCli(registerDevicesCommand, [
        'devices',
        'describe',
        'BLE-001',
        '--live',
        '--json',
      ]);
      expect(res.exitCode).toBeNull(); // not a fatal exit
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data.source).toBe('catalog+live');
      expect(parsed.data.capabilities.liveStatus).toHaveProperty('error', 'device offline');
    });

    it('returns source=none when device type is unknown and --live not set', async () => {
      const unknownTypeBody = {
        deviceList: [{
          deviceId: 'UNKNOWN-1',
          deviceName: 'Future Device',
          deviceType: 'UnknownDeviceType2025',
          hubDeviceId: 'HUB-1',
          enableCloudService: true,
        }],
        infraredRemoteList: [],
      };
      apiMock.__instance.get.mockResolvedValueOnce({ data: { body: unknownTypeBody } });
      const res = await runCli(registerDevicesCommand, [
        'devices',
        'describe',
        'UNKNOWN-1',
        '--json',
      ]);
      expect(res.exitCode).toBeNull();
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data.source).toBe('none');
      expect(parsed.data.capabilities).toBeNull();
    });

    it('propagates API errors via handleError (exit 1)', async () => {
      apiMock.__instance.get.mockRejectedValue(new Error('boom'));
      const res = await runCli(registerDevicesCommand, ['devices', 'describe', 'BLE-001']);
      expect(res.exitCode).toBe(1);
      expect(res.stderr.join('\n')).toContain('boom');
    });

    it('fails when <deviceId> is missing (commander error)', async () => {
      const res = await runCli(registerDevicesCommand, ['devices', 'describe']);
      expect(res.stderr.join('\n').toLowerCase()).toContain('required');
    });
  });

  // =====================================================================
  // command — cache-backed validation
  // =====================================================================
  describe('command — cache-backed validation', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-cmd-validate-'));
      vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
      // Seed the cache: DID → Bot (commands: turnOn/turnOff/press, all param '—').
      updateCacheFromDeviceList({
        deviceList: [
          { deviceId: DID, deviceName: 'Living Bot', deviceType: 'Bot' },
          { deviceId: 'BULB-1', deviceName: 'Lamp', deviceType: 'Color Bulb' },
        ],
        infraredRemoteList: [
          { deviceId: 'IR-X', deviceName: 'Remote', remoteType: 'TV' },
        ],
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('rejects an unsupported command with exit 2 and prints supported list', async () => {
      const res = await runCmd('doesNotExist');
      expect(res.exitCode).toBe(2);
      const err = res.stderr.join('\n');
      expect(err).toContain('"doesNotExist" is not a supported command');
      expect(err).toContain('Living Bot');
      expect(err).toContain('Bot');
      expect(err).toContain('Supported commands:');
      expect(err).toContain('turnOn');
      expect(err).toContain('press');
      expect(err).toContain("switchbot devices commands");
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('rejects read-only device commands (meter) with exit 2', async () => {
      updateCacheFromDeviceList({
        deviceList: [
          { deviceId: DID, deviceName: 'Bedroom Meter', deviceType: 'Meter' },
        ],
        infraredRemoteList: [],
      });
      const res = await runCmd('turnOn');
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/read-only sensor/i);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('--allow-unknown-device does not bypass read-only rejection for cached devices', async () => {
      updateCacheFromDeviceList({
        deviceList: [
          { deviceId: DID, deviceName: 'Bedroom Meter', deviceType: 'Meter' },
        ],
        infraredRemoteList: [],
      });
      const res = await runCmd('turnOn', '--allow-unknown-device');
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/read-only sensor/i);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('rejects a parameter on a no-param command with exit 2', async () => {
      const res = await runCmd('turnOn', 'someparam');
      expect(res.exitCode).toBe(2);
      const err = res.stderr.join('\n');
      expect(err).toContain('"turnOn" takes no parameter');
      expect(err).toContain('someparam');
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('allows a supported no-param command to pass through', async () => {
      const res = await runCmd('turnOn');
      expect(res.exitCode).toBeNull();
      expectPost('turnOn', 'default');
    });

    it('allows "default" literal as parameter on a no-param command', async () => {
      const res = await runCmd('turnOn', 'default');
      expect(res.exitCode).toBeNull();
      expectPost('turnOn', 'default');
    });

    it('skips validation entirely for --type customize (arbitrary IR button names)', async () => {
      const res = await runCmd('AnyCustomName', 'extra', '--type', 'customize');
      expect(res.exitCode).toBeNull();
      expectPost('AnyCustomName', 'extra', 'customize');
    });

    it('validates against a parameterized command (Color Bulb setBrightness)', async () => {
      // For BULB-1 (Color Bulb), setBrightness takes a param — a numeric value is fine.
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', 'BULB-1', 'setBrightness', '50',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledWith(
        '/v1.1/devices/BULB-1/commands',
        { command: 'setBrightness', parameter: 50, commandType: 'command' }
      );
    });

    it('rejects an unsupported command on an IR remote (TV) with exit 2', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', 'IR-X', 'explode',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toContain('is not a supported command');
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('rejects devices not in the cache without --allow-unknown-device (B-3, 2.6.0)', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', 'UNKNOWN-ID', 'anyCommand',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/not in local cache/i);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('passes through commands for unknown devices with --allow-unknown-device', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', 'UNKNOWN-ID', 'anyCommand', '--allow-unknown-device',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledWith(
        '/v1.1/devices/UNKNOWN-ID/commands',
        { command: 'anyCommand', parameter: 'default', commandType: 'command' }
      );
    });
  });

  // =====================================================================
  // command — destructive-command guard
  // =====================================================================
  describe('command — destructive guard', () => {
    let tmpDir: string;
    const LOCK_ID = 'LOCK-1';

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-destructive-'));
      vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
      updateCacheFromDeviceList({
        deviceList: [
          { deviceId: LOCK_ID, deviceName: 'Front Door', deviceType: 'Smart Lock' },
          { deviceId: 'BULB-1', deviceName: 'Lamp', deviceType: 'Color Bulb' },
        ],
        infraredRemoteList: [],
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('blocks Smart Lock unlock without --yes (exit 2, no POST)', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', LOCK_ID, 'unlock',
      ]);
      expect(res.exitCode).toBe(2);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      expect(res.stderr.join('\n')).toMatch(/destructive command "unlock"/);
      expect(res.stderr.join('\n')).toMatch(/--yes/);
    });

    it('allows Smart Lock unlock when --yes is passed', async () => {
      apiMock.__instance.post.mockResolvedValue({
        data: { statusCode: 100, body: {} },
      });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', LOCK_ID, 'unlock', '--yes',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledWith(
        `/v1.1/devices/${LOCK_ID}/commands`,
        { command: 'unlock', parameter: 'default', commandType: 'command' }
      );
    });

    it('allows --dry-run without --yes (guard yields to dry-run preview)', async () => {
      apiMock.__instance.post.mockImplementation(async () => {
        throw new apiMock.DryRunSignal('POST', `/v1.1/devices/${LOCK_ID}/commands`);
      });
      const res = await runCli(registerDevicesCommand, [
        '--dry-run', 'devices', 'command', LOCK_ID, 'unlock',
      ]);
      // The guard must NOT block with exit 2 — dry-run is always allowed. The
      // stderr must not carry the destructive-block message either.
      expect(res.exitCode).not.toBe(2);
      expect(res.stderr.join('\n')).not.toMatch(/destructive command "unlock"/);
    });

    it('does not guard non-destructive commands (turnOn on a Bulb)', async () => {
      apiMock.__instance.post.mockResolvedValue({
        data: { statusCode: 100, body: {} },
      });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', 'BULB-1', 'turnOn',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
    });

    it('emits JSON error shape when --json is set and command is blocked', async () => {
      const res = await runCli(registerDevicesCommand, [
        '--json', 'devices', 'command', LOCK_ID, 'unlock',
      ]);
      expect(res.exitCode).toBe(2);
      // Bug #SYS-1: --json errors now go to stdout so piped consumers can
      // decode them the same way as success envelopes.
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.error.kind).toBe('guard');
      expect(parsed.error.code).toBe(2);
      expect(parsed.error.context.deviceId).toBe(LOCK_ID);
      expect(parsed.error.context.command).toBe('unlock');
      expect(parsed.error.context.deviceType).toBe('Smart Lock');
    });

    it('does not guard --type customize (user-defined IR buttons)', async () => {
      apiMock.__instance.post.mockResolvedValue({
        data: { statusCode: 100, body: {} },
      });
      // Even if the button name happens to collide with a destructive command,
      // customize IR buttons are opaque to the catalog and always allowed.
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', LOCK_ID, 'unlock', '--type', 'customize',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
    });
  });

  // =====================================================================
  // command — raw-parameter validation (setAll / setPosition / setMode)
  // =====================================================================
  describe('command — raw-parameter validation', () => {
    let tmpDir: string;
    const AC_ID = 'AC-VAL';
    const CURTAIN_ID = 'CURTAIN-VAL';
    const BLIND_ID = 'BLIND-VAL';
    const RELAY_ID = 'RELAY-VAL';

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-param-validate-'));
      vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
      updateCacheFromDeviceList({
        deviceList: [
          { deviceId: CURTAIN_ID, deviceName: 'Living Curtain', deviceType: 'Curtain' },
          { deviceId: BLIND_ID, deviceName: 'Bedroom Blind', deviceType: 'Blind Tilt' },
          { deviceId: RELAY_ID, deviceName: 'Relay', deviceType: 'Relay Switch 2PM' },
        ],
        infraredRemoteList: [
          { deviceId: AC_ID, deviceName: 'Living AC', remoteType: 'Air Conditioner' },
        ],
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('rejects malformed setAll ("on,2,2,30") before POST', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', AC_ID, 'setAll', 'on,2,2,30',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/temp.*16-30/i);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('rejects empty setAll parameter', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', AC_ID, 'setAll', '',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/requires a parameter/);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('rejects JSON-shaped setAll parameter', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', AC_ID, 'setAll', '{"temp":30}',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/CSV string/);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('rejects setAll with wrong field count', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', AC_ID, 'setAll', '30',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/4 comma-separated/);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('accepts valid setAll CSV', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', AC_ID, 'setAll', '26,2,2,on',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledWith(
        `/v1.1/devices/${AC_ID}/commands`,
        { command: 'setAll', parameter: '26,2,2,on', commandType: 'command' }
      );
    });

    it('accepts Curtain setPosition single-value form', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', CURTAIN_ID, 'setPosition', '50',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledWith(
        `/v1.1/devices/${CURTAIN_ID}/commands`,
        { command: 'setPosition', parameter: 50, commandType: 'command' }
      );
    });

    it('accepts Curtain setPosition tuple form', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', CURTAIN_ID, 'setPosition', '0,ff,50',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledWith(
        `/v1.1/devices/${CURTAIN_ID}/commands`,
        { command: 'setPosition', parameter: '0,ff,50', commandType: 'command' }
      );
    });

    it('rejects Blind Tilt setPosition with bad direction', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', BLIND_ID, 'setPosition', 'left;50',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/up.*down/);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });

    it('rejects Relay Switch setMode with bad channel', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', RELAY_ID, 'setMode', '3;1',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/1 or 2/);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // command — case-insensitive command name normalization
  // =====================================================================
  describe('command — case normalization', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-case-'));
      vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
      updateCacheFromDeviceList({
        deviceList: [
          { deviceId: DID, deviceName: 'Living Bot', deviceType: 'Bot' },
        ],
        infraredRemoteList: [],
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('normalizes "turnon" to "turnOn" and POSTs canonical name', async () => {
      const res = await runCmd('turnon');
      expect(res.exitCode).toBeNull();
      expect(res.stderr.join('\n')).toMatch(/'turnon' normalized to 'turnOn'/);
      expectPost('turnOn', 'default');
    });

    it('normalizes "TurnOn" to "turnOn"', async () => {
      const res = await runCmd('TurnOn');
      expect(res.exitCode).toBeNull();
      expect(res.stderr.join('\n')).toMatch(/'TurnOn' normalized to 'turnOn'/);
      expectPost('turnOn', 'default');
    });

    it('--json output uses the canonical command name', async () => {
      const res = await runCmd('turnon', '--json');
      expect(res.exitCode).toBeNull();
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data.command).toBe('turnOn');
    });

    it('still rejects genuinely unknown commands with exit 2', async () => {
      const res = await runCmd('foobar');
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/is not a supported command/);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // command — --name resolver + positional args
  // =====================================================================
  describe('command — --name + positional shift', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-name-'));
      vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
      updateCacheFromDeviceList({
        deviceList: [
          { deviceId: 'AC-FUZZY', deviceName: 'Living Room AC', deviceType: 'Air Conditioner' },
          { deviceId: 'BOT-FUZZY', deviceName: 'Kitchen Bot', deviceType: 'Bot' },
        ],
        infraredRemoteList: [],
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resolves --name + bare command (no parameter)', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', '--name', 'Kitchen', 'turnOn',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledWith(
        '/v1.1/devices/BOT-FUZZY/commands',
        { command: 'turnOn', parameter: 'default', commandType: 'command' }
      );
    });

    it('resolves --name + command + parameter (positional shift)', async () => {
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', '--name', 'Living Room', 'setAll', '26,2,2,on',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledWith(
        '/v1.1/devices/AC-FUZZY/commands',
        { command: 'setAll', parameter: '26,2,2,on', commandType: 'command' }
      );
    });

    it('resolves --name + command + color parameter with colons', async () => {
      updateCacheFromDeviceList({
        deviceList: [
          { deviceId: 'BULB-FUZZY', deviceName: 'Desk Lamp', deviceType: 'Color Bulb' },
        ],
        infraredRemoteList: [],
      });
      const res = await runCli(registerDevicesCommand, [
        'devices', 'command', '--name', 'Desk', 'setColor', '255:0:0',
      ]);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).toHaveBeenCalledWith(
        '/v1.1/devices/BULB-FUZZY/commands',
        { command: 'setColor', parameter: '255:0:0', commandType: 'command' }
      );
    });
  });

  // =====================================================================
  // command — dry-run structured output (bug #36)
  // =====================================================================
  describe('command — dry-run output', () => {
    const DRY_ID = 'DRY-DEV-1';

    beforeEach(() => {
      // Seed DRY_ID so B-3's unknown-device gate doesn't shadow the dry-run
      // plumbing we're actually testing here.
      updateCacheFromDeviceList({
        deviceList: [
          { deviceId: DRY_ID, deviceName: 'Dry Run Bot', deviceType: 'Bot', hubDeviceId: 'HUB-1', enableCloudService: true },
        ],
        infraredRemoteList: [],
      });
      // Make post throw DryRunSignal (simulates --dry-run interceptor)
      apiMock.__instance.post.mockImplementation(async () => {
        throw new apiMock.DryRunSignal('POST', `/v1.1/devices/${DRY_ID}/commands`);
      });
    });

    it('emits structured JSON with dryRun:true when --dry-run --json', async () => {
      const res = await runCli(registerDevicesCommand, [
        '--dry-run', '--json', 'devices', 'command', DRY_ID, 'turnOff',
      ]);
      expect(res.exitCode).toBeNull();
      // post was called (and threw DryRunSignal — that's the mechanism), but the API
      // result was never used; we verify the structured output instead.
      expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
      // stdout must have valid JSON
      const out = res.stdout.join('\n');
      expect(out).toBeTruthy();
      const parsed = JSON.parse(out);
      expect(parsed.schemaVersion).toBe('1.1');
      expect(parsed.data.dryRun).toBe(true);
      expect(parsed.data.wouldSend.deviceId).toBe(DRY_ID);
      expect(parsed.data.wouldSend.command).toBe('turnOff');
      expect(parsed.data.wouldSend.commandType).toBe('command');
    });

    it('emits human-readable dry-run message to stdout when --dry-run (no --json)', async () => {
      const res = await runCli(registerDevicesCommand, [
        '--dry-run', 'devices', 'command', DRY_ID, 'turnOn',
      ]);
      expect(res.exitCode).toBeNull();
      const out = res.stdout.join('\n');
      expect(out).toMatch(/dry-run/i);
      expect(out).toContain(DRY_ID);
    });
  });

  // =====================================================================
  // --help --json
  // =====================================================================
  describe('--help --json', () => {
    it('devices list --help --json returns structured JSON', async () => {
      const res = await runCli(registerDevicesCommand, ['--json', 'devices', 'list', '--help']);
      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.schemaVersion).toBe('1.1');
      expect(parsed.data.name).toBe('list');
      expect(Array.isArray(parsed.data.options)).toBe(true);
      expect(Array.isArray(parsed.data.arguments)).toBe(true);
      expect(parsed.data.options.some((o: { flags: string }) => o.flags.includes('--filter'))).toBe(true);
    });

    it('devices command --help --json includes arguments', async () => {
      const res = await runCli(registerDevicesCommand, ['--json', 'devices', 'command', '--help']);
      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data.name).toBe('command');
      expect(parsed.data.arguments.length).toBeGreaterThan(0);
    });
  });

  // =====================================================================
  // destructive normalization
  // =====================================================================
  describe('devices commands --json destructive normalization', () => {
    it('every command in Bot catalog has explicit destructive boolean', async () => {
      const res = await runCli(registerDevicesCommand, ['--json', 'devices', 'commands', 'Bot']);
      expect(res.exitCode).toBeNull();
      const parsed = JSON.parse(res.stdout.join('\n'));
      const cmds: Array<{ destructive?: boolean }> = parsed.data.commands;
      expect(cmds.length).toBeGreaterThan(0);
      for (const c of cmds) {
        expect(typeof c.destructive).toBe('boolean');
      }
    });

    it('Smart Lock unlock has destructive:true, lock has destructive:false', async () => {
      const res = await runCli(registerDevicesCommand, ['--json', 'devices', 'commands', 'Smart Lock']);
      expect(res.exitCode).toBeNull();
      const parsed = JSON.parse(res.stdout.join('\n'));
      const cmds: Array<{ command: string; destructive: boolean }> = parsed.data.commands;
      const unlock = cmds.find((c) => c.command === 'unlock');
      const lock = cmds.find((c) => c.command === 'lock');
      expect(unlock?.destructive).toBe(true);
      expect(lock?.destructive).toBe(false);
    });
  });
});
