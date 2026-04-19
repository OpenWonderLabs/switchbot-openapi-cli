import type { AxiosInstance } from 'axios';
import { createClient } from '../api/client.js';
import { idempotencyCache } from './idempotency.js';
import {
  findCatalogEntry,
  suggestedActions,
  getEffectiveCatalog,
  type DeviceCatalogEntry,
  type CommandSpec,
} from '../devices/catalog.js';
import {
  getCachedDevice,
  updateCacheFromDeviceList,
  loadCache,
  isListCacheFresh,
  getCachedStatus,
  setCachedStatus,
} from '../devices/cache.js';
import { getCacheMode } from '../utils/flags.js';
import { writeAudit } from '../utils/audit.js';
import { isDryRun } from '../utils/flags.js';

export interface Device {
  deviceId: string;
  deviceName: string;
  deviceType?: string;
  enableCloudService: boolean;
  hubDeviceId: string;
  roomID?: string;
  roomName?: string | null;
  familyName?: string;
  controlType?: string;
}

export interface InfraredDevice {
  deviceId: string;
  deviceName: string;
  remoteType: string;
  hubDeviceId: string;
  controlType?: string;
}

export interface DeviceListBody {
  deviceList: Device[];
  infraredRemoteList: InfraredDevice[];
}

export interface DescribeCapabilities {
  role: string | null;
  readOnly: boolean;
  commands: CommandSpec[];
  statusFields: string[];
  liveStatus?: Record<string, unknown>;
}

export interface DescribeResult {
  device: Device | InfraredDevice;
  isPhysical: boolean;
  typeName: string;
  controlType: string | null;
  catalog: DeviceCatalogEntry | null;
  capabilities: DescribeCapabilities | { liveStatus: Record<string, unknown> } | null;
  source: 'catalog' | 'live' | 'catalog+live' | 'none';
  suggestedActions: ReturnType<typeof suggestedActions>;
  /** For IR remotes: the family/room inherited from their bound Hub. Undefined for physical devices. */
  inheritedLocation?: { family?: string; room?: string; roomID?: string };
}

export class DeviceNotFoundError extends Error {
  constructor(public readonly deviceId: string) {
    super(`No device with id "${deviceId}" found on this account.`);
    this.name = 'DeviceNotFoundError';
  }
}

export class CommandValidationError extends Error {
  constructor(
    message: string,
    public readonly kind: 'unknown-command' | 'unexpected-parameter',
    public readonly hint?: string
  ) {
    super(message);
    this.name = 'CommandValidationError';
  }
}

/** Fetch the full device + IR remote inventory and refresh the local cache. */
export async function fetchDeviceList(client?: AxiosInstance): Promise<DeviceListBody> {
  // TTL-gated read: when the on-disk cache is younger than the configured
  // list TTL, skip the API call and synthesize a DeviceListBody from the
  // metadata cache.
  const mode = getCacheMode();
  if (mode.listTtlMs > 0 && isListCacheFresh(mode.listTtlMs)) {
    const cached = loadCache();
    if (cached) {
      const deviceList: Device[] = [];
      const infraredRemoteList: InfraredDevice[] = [];
      for (const [deviceId, entry] of Object.entries(cached.devices)) {
        if (entry.category === 'physical') {
          deviceList.push({
            deviceId,
            deviceName: entry.name,
            deviceType: entry.type,
            enableCloudService: entry.enableCloudService ?? true,
            hubDeviceId: entry.hubDeviceId ?? '',
            roomID: entry.roomID,
            roomName: entry.roomName,
            familyName: entry.familyName,
            controlType: entry.controlType,
          });
        } else {
          infraredRemoteList.push({
            deviceId,
            deviceName: entry.name,
            remoteType: entry.type,
            hubDeviceId: entry.hubDeviceId ?? '',
            controlType: entry.controlType,
          });
        }
      }
      return { deviceList, infraredRemoteList };
    }
  }
  const c = client ?? createClient();
  const res = await c.get<{ body: DeviceListBody }>('/v1.1/devices');
  updateCacheFromDeviceList(res.data.body);
  return res.data.body;
}

/** Fetch live status for a single physical device. IR remotes have no status channel. */
export async function fetchDeviceStatus(
  deviceId: string,
  client?: AxiosInstance
): Promise<Record<string, unknown>> {
  const mode = getCacheMode();
  if (mode.statusTtlMs > 0) {
    const cached = getCachedStatus(deviceId, mode.statusTtlMs);
    if (cached) return cached;
  }
  const c = client ?? createClient();
  const res = await c.get<{ body: Record<string, unknown> }>(
    `/v1.1/devices/${deviceId}/status`
  );
  if (mode.statusTtlMs > 0) {
    setCachedStatus(deviceId, res.data.body, new Date(), mode.statusTtlMs);
  }
  return res.data.body;
}

/**
 * Execute a command on a device. `parameter` is the fully-parsed value already
 * (JSON-object when applicable), not a raw CLI string — callers should parse
 * upstream if needed.
 */
export async function executeCommand(
  deviceId: string,
  cmd: string,
  parameter: unknown,
  commandType: 'command' | 'customize',
  client?: AxiosInstance,
  options?: { idempotencyKey?: string }
): Promise<unknown> {
  const c = client ?? createClient();
  const body = {
    command: cmd,
    parameter: parameter ?? 'default',
    commandType,
  };
  const baseAudit = {
    t: new Date().toISOString(),
    kind: 'command' as const,
    deviceId,
    command: cmd,
    parameter,
    commandType,
    dryRun: isDryRun(),
  };

  // Wrap in idempotency cache if key is provided
  const execute = async () => {
    try {
      const res = await c.post<{ body: unknown }>(
        `/v1.1/devices/${deviceId}/commands`,
        body
      );
      writeAudit({ ...baseAudit, result: 'ok' });
      return res.data.body;
    } catch (err) {
      // Dry-run intercepts throw DryRunSignal — still log the intent.
      if (err instanceof Error && err.name === 'DryRunSignal') {
        writeAudit({ ...baseAudit, result: 'ok' });
      } else {
        writeAudit({
          ...baseAudit,
          result: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  };

  return idempotencyCache.run<unknown>(options?.idempotencyKey, execute);
}

/**
 * Validate a command against the locally-cached device → catalog mapping.
 * Returns `{ ok: true }` when validation passes or is skipped (unknown device,
 * custom IR button, etc.); returns `{ ok: false, error }` when the caller
 * should refuse the call.
 */
export function validateCommand(
  deviceId: string,
  cmd: string,
  parameter: string | undefined,
  commandType: string
): { ok: true } | { ok: false; error: CommandValidationError } {
  if (commandType === 'customize') return { ok: true };

  const cached = getCachedDevice(deviceId);
  if (!cached) return { ok: true };

  const match = findCatalogEntry(cached.type);
  if (!match || Array.isArray(match)) return { ok: true };

  const builtinCommands = match.commands.filter((c) => c.commandType !== 'customize');
  if (builtinCommands.length === 0) return { ok: true };

  const spec = builtinCommands.find((c) => c.command === cmd);
  if (!spec) {
    const unique = [...new Set(builtinCommands.map((c) => c.command))];
    return {
      ok: false,
      error: new CommandValidationError(
        `"${cmd}" is not a supported command for ${cached.name} (${cached.type}).`,
        'unknown-command',
        `Supported commands: ${unique.join(', ')}`
      ),
    };
  }

  const noParamExpected = spec.parameter === '—';
  const userProvidedParam = parameter !== undefined && parameter !== 'default';
  if (noParamExpected && userProvidedParam) {
    return {
      ok: false,
      error: new CommandValidationError(
        `"${cmd}" takes no parameter, but one was provided: "${parameter}".`,
        'unexpected-parameter',
        `Try: switchbot devices command ${deviceId} ${cmd}`
      ),
    };
  }

  return { ok: true };
}

/**
 * Inspect catalog annotations to decide whether a command is destructive,
 * i.e. has hard-to-reverse real-world effects and should require an explicit
 * confirmation from an agent / operator before execution. Customize commands
 * are considered non-destructive here — they're user-defined IR buttons
 * whose behavior the catalog can't know about.
 */
export function isDestructiveCommand(
  deviceType: string | undefined,
  cmd: string,
  commandType: string
): boolean {
  if (commandType === 'customize') return false;
  if (!deviceType) return false;
  const match = findCatalogEntry(deviceType);
  if (!match || Array.isArray(match)) return false;
  const spec = match.commands.find((c) => c.command === cmd);
  return Boolean(spec?.destructive);
}

/** Return the destructiveReason for a command, or null if not destructive / not found. */
export function getDestructiveReason(
  deviceType: string | undefined,
  cmd: string,
  commandType: string
): string | null {
  if (commandType === 'customize') return null;
  if (!deviceType) return null;
  const match = findCatalogEntry(deviceType);
  if (!match || Array.isArray(match)) return null;
  const spec = match.commands.find((c) => c.command === cmd);
  return spec?.destructiveReason ?? null;
}

/**
 * Describe a device by id: metadata + catalog entry (if known) +
 * optional live status. Throws `DeviceNotFoundError` when the id is unknown.
 */
export async function describeDevice(
  deviceId: string,
  options: { live?: boolean } = {},
  client?: AxiosInstance
): Promise<DescribeResult> {
  const body = await fetchDeviceList(client);
  const { deviceList, infraredRemoteList } = body;

  const physical = deviceList.find((d) => d.deviceId === deviceId);
  const ir = infraredRemoteList.find((d) => d.deviceId === deviceId);

  if (!physical && !ir) throw new DeviceNotFoundError(deviceId);

  const typeName = physical ? (physical.deviceType ?? '') : ir!.remoteType;
  const match = typeName ? findCatalogEntry(typeName) : null;
  const catalogEntry = !match || Array.isArray(match) ? null : match;

  let liveStatus: Record<string, unknown> | undefined;
  if (options.live && physical) {
    try {
      liveStatus = await fetchDeviceStatus(deviceId, client);
    } catch (err) {
      liveStatus = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  const source: 'catalog' | 'live' | 'catalog+live' | 'none' = catalogEntry
    ? liveStatus
      ? 'catalog+live'
      : 'catalog'
    : liveStatus
      ? 'live'
      : 'none';

  const capabilities: DescribeResult['capabilities'] = catalogEntry
    ? {
        role: catalogEntry.role ?? null,
        readOnly: catalogEntry.readOnly ?? false,
        commands: catalogEntry.commands,
        statusFields: catalogEntry.statusFields ?? [],
        ...(liveStatus !== undefined ? { liveStatus } : {}),
      }
    : liveStatus !== undefined
      ? { liveStatus }
      : null;

  return {
    device: (physical ?? ir) as Device | InfraredDevice,
    isPhysical: Boolean(physical),
    typeName,
    controlType: physical?.controlType ?? ir?.controlType ?? null,
    catalog: catalogEntry,
    capabilities,
    source,
    suggestedActions: catalogEntry ? suggestedActions(catalogEntry) : [],
    inheritedLocation: ir ? buildHubLocationMap(deviceList).get(ir.hubDeviceId) : undefined,
  };
}

/** Build a map from hubDeviceId → room/family/roomID for IR-remote inheritance. */
export function buildHubLocationMap(
  deviceList: Device[]
): Map<string, { family?: string; room?: string; roomID?: string }> {
  const map = new Map<string, { family?: string; room?: string; roomID?: string }>();
  for (const d of deviceList) {
    if (!d.deviceId) continue;
    map.set(d.deviceId, {
      family: d.familyName ?? undefined,
      room: d.roomName ?? undefined,
      roomID: d.roomID ?? undefined,
    });
  }
  return map;
}

/**
 * Search the local catalog by type name / alias. Returns up to `limit`
 * entries whose type or alias contains the query (case-insensitive).
 * Intended for MCP's `search_catalog` tool — not for dispatching commands.
 */
export function searchCatalog(query: string, limit = 20): DeviceCatalogEntry[] {
  const catalog = getEffectiveCatalog();
  const q = query.trim().toLowerCase();
  if (!q) return catalog.slice(0, limit);

  const hits: DeviceCatalogEntry[] = [];
  for (const entry of catalog) {
    const haystack = [entry.type, ...(entry.aliases ?? [])].map((s) => s.toLowerCase());
    if (haystack.some((h) => h.includes(q))) {
      hits.push(entry);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/** Shape expected by the MCP describe_device outputSchema. */
export interface McpDescribeShape {
  device: {
    deviceId: string;
    deviceName: string;
    deviceType?: string;
    enableCloudService?: boolean;
    hubDeviceId?: string;
    roomID?: string;
    roomName?: string | null;
    familyName?: string;
    controlType?: string;
    remoteType?: string;
  };
  isPhysical: boolean;
  typeName: string;
  controlType: string | null;
  source: 'catalog' | 'live' | 'catalog+live' | 'none';
  capabilities: unknown;
  suggestedActions: Array<{ command: string; parameter?: string; description: string }>;
  inheritedLocation?: { family?: string; room?: string };
}

/** Convert a DescribeResult to the shape validated by the MCP outputSchema. */
export function toMcpDescribeShape(r: DescribeResult): McpDescribeShape {
  const d = r.device as Device & Partial<InfraredDevice>;
  return {
    device: {
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      ...(d.deviceType !== undefined ? { deviceType: d.deviceType } : {}),
      ...('enableCloudService' in d ? { enableCloudService: d.enableCloudService } : {}),
      ...(d.hubDeviceId !== undefined ? { hubDeviceId: d.hubDeviceId } : {}),
      ...(d.roomID !== undefined ? { roomID: d.roomID } : {}),
      ...(d.roomName !== undefined ? { roomName: d.roomName } : {}),
      ...(d.familyName !== undefined ? { familyName: d.familyName } : {}),
      ...(d.controlType !== undefined ? { controlType: d.controlType } : {}),
      ...('remoteType' in d && d.remoteType !== undefined ? { remoteType: d.remoteType } : {}),
    },
    isPhysical: r.isPhysical,
    typeName: r.typeName,
    controlType: r.controlType,
    source: r.source,
    capabilities: r.capabilities,
    suggestedActions: r.suggestedActions,
    ...(r.inheritedLocation !== undefined
      ? { inheritedLocation: { family: r.inheritedLocation.family, room: r.inheritedLocation.room } }
      : {}),
  };
}

/** Shapes the device list body for the MCP list_devices outputSchema. */
export function toMcpDeviceListShape(d: Device): Record<string, unknown> {
  return {
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    deviceType: d.deviceType,
    enableCloudService: d.enableCloudService,
    hubDeviceId: d.hubDeviceId,
    roomID: d.roomID,
    roomName: d.roomName,
    familyName: d.familyName,
    controlType: d.controlType,
  };
}

/** Shapes an infrared remote for the MCP list_devices outputSchema. */
export function toMcpIrDeviceShape(d: InfraredDevice): Record<string, unknown> {
  return {
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    remoteType: d.remoteType,
    hubDeviceId: d.hubDeviceId,
    controlType: d.controlType,
  };
}
