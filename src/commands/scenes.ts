import { Command } from 'commander';
import { printTable, printJson, isJsonMode, handleError } from '../utils/output.js';
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

Examples:
  $ switchbot scenes list
  $ switchbot scenes list --json
`)
    .action(async () => {
      try {
        const scenes = await fetchScenes();

        if (isJsonMode()) {
          printJson(scenes);
          return;
        }

        if (scenes.length === 0) {
          console.log('No scenes found');
          return;
        }

        printTable(
          ['sceneId', 'sceneName'],
          scenes.map((s) => [s.sceneId, s.sceneName])
        );
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
        console.log(`✓ Scene executed: ${sceneId}`);
      } catch (error) {
        handleError(error);
      }
    });
}
