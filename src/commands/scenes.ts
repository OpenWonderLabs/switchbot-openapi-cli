import { Command } from 'commander';
import { printJson, isJsonMode, handleError } from '../utils/output.js';
import { resolveFormat, resolveFields, renderRows } from '../utils/format.js';
import { fetchScenes, executeScene } from '../lib/scenes.js';

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
}
