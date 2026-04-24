import { Command } from 'commander';
import { printJson, isJsonMode, handleError } from '../utils/output.js';
import {
  describeDevice,
  fetchDeviceList,
  type Device,
  type InfraredDevice,
} from '../lib/devices.js';
import type { DescribeResult } from '../lib/devices.js';
import type { SafetyTier } from '../devices/catalog.js';

interface ExplainResult {
  deviceId: string;
  type: string;
  category: 'physical' | 'ir';
  name: string;
  role: string | null;
  readOnly: boolean;
  location?: { family?: string; room?: string };
  liveStatus?: Record<string, unknown>;
  commands: Array<{
    command: string;
    parameter: string;
    idempotent?: boolean;
    safetyTier?: SafetyTier;
  }>;
  statusFields: string[];
  children: Array<{ deviceId: string; name: string; type: string }>;
  suggestedActions: Array<{ command: string; parameter?: string; description: string }>;
  warnings: string[];
}

function deviceName(d: Device | InfraredDevice): string {
  return d.deviceName;
}

export function registerExplainCommand(devices: Command): void {
  devices
    .command('explain')
    .description('One-shot device summary: metadata + capabilities + live status + children (for Hubs)')
    .argument('<deviceId>', 'Device ID to explain')
    .option('--no-live', 'Skip the live status API call (catalog-only output)')
    .addHelpText('after', `
'explain' is the agent-friendly sibling of 'describe'. It combines:
  - metadata (id, name, type, category, role)
  - live status (unless --no-live)
  - commands with idempotent/destructive flags
  - children (for Hub devices: IR remotes bound to this hub)
  - suggested actions (pre-baked common usages)
  - warnings (deprecated types, missing cloud service, etc.)

Examples:
  $ switchbot devices explain <id>
  $ switchbot --json devices explain <id> | jq '.commands[] | select(.destructive)'
  $ switchbot devices explain <id> --no-live
`)
    .action(async (deviceId: string, options: { live?: boolean }) => {
      try {
        const wantLive = options.live !== false;
        const desc: DescribeResult = await describeDevice(deviceId, { live: wantLive });

        const warnings: string[] = [];
        if (desc.isPhysical && !(desc.device as Device).enableCloudService) {
          warnings.push('Cloud service disabled on this device — commands will fail.');
        }
        if (!desc.catalog) {
          warnings.push(`No catalog entry for type "${desc.typeName}". Commands cannot be validated offline.`);
        }

        let children: ExplainResult['children'] = [];
        if (desc.catalog?.role === 'hub') {
          const body = await fetchDeviceList();
          children = body.infraredRemoteList
            .filter((ir) => ir.hubDeviceId === deviceId)
            .map((ir) => ({ deviceId: ir.deviceId, name: ir.deviceName, type: ir.remoteType }));
        }

        const caps = desc.capabilities;
        const commands = caps && 'commands' in caps
          ? caps.commands.map((c) => {
              const tier = (c as { safetyTier?: SafetyTier }).safetyTier;
              return {
                command: c.command,
                parameter: c.parameter,
                idempotent: c.idempotent,
                ...(tier ? { safetyTier: tier } : {}),
              };
            })
          : [];
        const statusFields = caps && 'statusFields' in caps ? caps.statusFields : [];
        const liveStatus = caps && 'liveStatus' in caps ? caps.liveStatus : undefined;

        const location: ExplainResult['location'] = desc.isPhysical
          ? {
              family: (desc.device as Device).familyName,
              room: (desc.device as Device).roomName ?? undefined,
            }
          : desc.inheritedLocation
            ? { family: desc.inheritedLocation.family, room: desc.inheritedLocation.room }
            : undefined;

        const result: ExplainResult = {
          deviceId,
          type: desc.typeName,
          category: desc.isPhysical ? 'physical' : 'ir',
          name: deviceName(desc.device),
          role: desc.catalog?.role ?? null,
          readOnly: desc.catalog?.readOnly ?? false,
          location,
          liveStatus,
          commands,
          statusFields,
          children,
          suggestedActions: desc.suggestedActions,
          warnings,
        };

        if (isJsonMode()) {
          printJson(result);
          return;
        }
        printHuman(result);
      } catch (err) {
        handleError(err);
      }
    });
}

function printHuman(r: ExplainResult): void {
  console.log(`# ${r.name} (${r.deviceId})`);
  console.log(`type:     ${r.type} [${r.category}${r.role ? ', ' + r.role : ''}${r.readOnly ? ', read-only' : ''}]`);
  if (r.location?.family || r.location?.room) {
    const loc = [r.location?.family, r.location?.room].filter(Boolean).join(' / ');
    console.log(`location: ${loc}`);
  }
  if (r.warnings.length) {
    console.log('warnings:');
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }
  if (r.liveStatus && !('error' in r.liveStatus)) {
    console.log('live status:');
    for (const [k, v] of Object.entries(r.liveStatus)) {
      console.log(`  ${k}: ${JSON.stringify(v)}`);
    }
  } else if (r.liveStatus && 'error' in r.liveStatus) {
    console.log(`live status: error — ${r.liveStatus.error}`);
  }
  if (r.commands.length) {
    console.log('commands:');
    for (const c of r.commands) {
      const flags = [c.idempotent && 'idempotent', c.safetyTier === 'destructive' && 'destructive']
        .filter(Boolean)
        .join(', ');
      const suffix = flags ? `  [${flags}]` : '';
      console.log(`  ${c.command}${c.parameter !== '—' ? ` <${c.parameter}>` : ''}${suffix}`);
    }
  }
  if (r.statusFields.length) {
    console.log(`status fields: ${r.statusFields.join(', ')}`);
  }
  if (r.children.length) {
    console.log(`children (${r.children.length}):`);
    for (const c of r.children) {
      console.log(`  ${c.deviceId}  ${c.name}  [${c.type}]`);
    }
  }
  if (r.suggestedActions.length) {
    console.log('suggested:');
    for (const s of r.suggestedActions) {
      const param = s.parameter ? ` ${s.parameter}` : '';
      console.log(`  ${s.description}: ${s.command}${param}`);
    }
  }
}
