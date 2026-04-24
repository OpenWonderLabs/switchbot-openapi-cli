import { Command } from 'commander';
import { printJson, isJsonMode, handleError, StructuredUsageError } from '../utils/output.js';
import { resolveFormat, resolveFields, renderRows } from '../utils/format.js';
import { fetchScenes, executeScene } from '../lib/scenes.js';
import { isDryRun } from '../utils/flags.js';

export function registerScenesCommand(program: Command): void {
  const scenes = program
    .command('scenes')
    .description('Manage and execute SwitchBot scenes');

  // switchbot scenes list
  scenes
    .command('list')
    .description('List all manual scenes (scenes created in the SwitchBot app)')
    .addHelpText('after', `
Output columns: sceneId, sceneName
--fields accepts any subset of these names (exit 2 on unknown names).

Examples:
  $ switchbot scenes list
  $ switchbot scenes list --format tsv --fields sceneId,sceneName
  $ switchbot scenes list --format id
  $ switchbot scenes list --json
`)
    .action(async () => {
      try {
        const scenes = await fetchScenes();
        const fmt = resolveFormat();

        if (fmt === 'json' && process.argv.includes('--json')) {
          printJson(scenes);
          return;
        }

        renderRows(
          ['sceneId', 'sceneName'],
          scenes.map((s) => [s.sceneId, s.sceneName]),
          fmt,
          resolveFields(),
          { id: 'sceneId', name: 'sceneName' },
        );
        if (fmt === 'table' && scenes.length === 0) {
          console.log('No scenes found');
        }
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot scenes execute <sceneId>
  scenes
    .command('execute')
    .description('Execute a manual scene by its ID')
    .argument('<sceneId>', 'Scene ID from "scenes list"')
    .addHelpText('after', `
Example:
  $ switchbot scenes execute T12345678
`)
    .action(async (sceneId: string) => {
      try {
        const sceneList = await fetchScenes();
        const found = sceneList.find((s) => s.sceneId === sceneId);
        if (!found) {
          throw new StructuredUsageError(`scene not found: ${sceneId}`, {
            error: 'scene_not_found',
            sceneId,
            candidates: sceneList.map((s) => ({ sceneId: s.sceneId, sceneName: s.sceneName })),
          });
        }
        if (isDryRun()) {
          const wouldSend = { method: 'POST', url: `/v1.1/scenes/${sceneId}/execute`, sceneId, sceneName: found.sceneName };
          if (isJsonMode()) {
            printJson({ dryRun: true, wouldSend });
          } else {
            console.log(`[dry-run] Would POST /v1.1/scenes/${sceneId}/execute (${found.sceneName})`);
          }
          return;
        }
        await executeScene(sceneId);
        if (isJsonMode()) {
          printJson({ ok: true, sceneId });
        } else {
          console.log(`✓ Scene executed: ${sceneId}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot scenes describe <sceneId>
  scenes
    .command('describe')
    .description('Show metadata for a scene by its ID (SwitchBot API v1.1 does not expose step detail)')
    .argument('<sceneId>', 'Scene ID from "scenes list"')
    .addHelpText('after', `
Note: SwitchBot API v1.1 does not return scene step detail. Only the scene name is available.

Example:
  $ switchbot scenes describe T12345678
`)
    .action(async (sceneId: string) => {
      try {
        const sceneList = await fetchScenes();
        const found = sceneList.find((s) => s.sceneId === sceneId);
        if (!found) {
          throw new StructuredUsageError(`scene not found: ${sceneId}`, {
            error: 'scene_not_found',
            sceneId,
            candidates: sceneList.map((s) => ({ sceneId: s.sceneId, sceneName: s.sceneName })),
          });
        }
        const result = {
          sceneId: found.sceneId,
          sceneName: found.sceneName,
          stepCount: null,
          note: 'SwitchBot API v1.1 does not expose scene steps — displayed name only',
        };
        if (isJsonMode()) {
          printJson(result);
        } else {
          console.log(`sceneId:   ${result.sceneId}`);
          console.log(`sceneName: ${result.sceneName}`);
          console.log(`stepCount: (not available)`);
          console.log(`note:      ${result.note}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot scenes validate [sceneId...]
  scenes
    .command('validate')
    .description('Verify that one or more scenes exist. If no IDs are given, validates all scenes are reachable.')
    .argument('[sceneId...]', 'Scene IDs to validate (default: all scenes)')
    .addHelpText('after', `
Note: SwitchBot API v1.1 does not expose scene steps; validation only confirms
the scene IDs exist in your account.

Examples:
  $ switchbot scenes validate
  $ switchbot scenes validate T12345678 T87654321
`)
    .action(async (sceneIds: string[]) => {
      try {
        const sceneList = await fetchScenes();
        const sceneMap = new Map(sceneList.map((s) => [s.sceneId, s.sceneName]));
        const targets = sceneIds.length > 0 ? sceneIds : sceneList.map((s) => s.sceneId);
        const results = targets.map((id) => ({
          sceneId: id,
          sceneName: sceneMap.get(id) ?? null,
          valid: sceneMap.has(id),
        }));
        const allValid = results.every((r) => r.valid);
        if (isJsonMode()) {
          printJson({ ok: allValid, results });
          if (!allValid) process.exit(1);
          return;
        }
        for (const r of results) {
          const icon = r.valid ? '✓' : '✗';
          const label = r.valid ? r.sceneName! : '(not found)';
          console.log(`${icon} ${r.sceneId}  ${label}`);
        }
        if (!allValid) process.exit(1);
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot scenes simulate <sceneId>
  scenes
    .command('simulate')
    .description('Show what `scenes execute` would do without actually executing the scene.')
    .argument('<sceneId>', 'Scene ID from "scenes list"')
    .addHelpText('after', `
Note: SwitchBot API v1.1 does not expose scene step details. Simulation reports
the scene name, confirms it exists, and shows the POST that would be issued.

Example:
  $ switchbot scenes simulate T12345678
`)
    .action(async (sceneId: string) => {
      try {
        const sceneList = await fetchScenes();
        const found = sceneList.find((s) => s.sceneId === sceneId);
        if (!found) {
          throw new StructuredUsageError(`scene not found: ${sceneId}`, {
            error: 'scene_not_found',
            sceneId,
            candidates: sceneList.map((s) => ({ sceneId: s.sceneId, sceneName: s.sceneName })),
          });
        }
        const simulation = {
          sceneId: found.sceneId,
          sceneName: found.sceneName,
          wouldSend: { method: 'POST', url: `/v1.1/scenes/${sceneId}/execute` },
          note: 'SwitchBot API v1.1 does not expose individual scene steps.',
        };
        if (isJsonMode()) {
          printJson({ simulated: true, ...simulation });
          return;
        }
        console.log(`sceneId:   ${simulation.sceneId}`);
        console.log(`sceneName: ${simulation.sceneName}`);
        console.log(`wouldSend: ${simulation.wouldSend.method} ${simulation.wouldSend.url}`);
        console.log(`note:      ${simulation.note}`);
      } catch (error) {
        handleError(error);
      }
    });
}
