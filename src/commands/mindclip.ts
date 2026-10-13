import { Command } from 'commander';
import { intArg, enumArg, stringArg, dateArg, weekArg } from '../utils/arg-parsers.js';
import { printJson, handleError } from '../utils/output.js';
import {
  listRecordings,
  getRecording,
  getTranscript,
  getSummary,
  listTodos,
  getDailyRecall,
  getWeeklySummary,
  getUrgentTodos,
} from '../lib/mindclip.js';

export function registerMindclipCommand(program: Command): void {
  const mindclip = program
    .command('mindclip')
    .description('Access AI MindClip recordings, summaries, and to-dos')
    .addHelpText(
      'after',
      `
Subcommands:
  recordings      List recordings for an AI MindClip device
  recording <id>  Get a single recording's metadata
  transcript <id> Get a recording's transcript and transcription status
  summary <id>    Get AI summary for a recording
  todos           List AI-extracted to-do items
  daily           Get daily recall summary
  weekly          Get weekly summary
  urgent-todos    Get urgent to-dos for a date

Examples:
  switchbot mindclip recordings --device AABBCCDDEEFF --page 1 --size 10
  switchbot mindclip todos --completed 1 --page 1 --size 10
  switchbot mindclip daily --date 2026-06-10
  switchbot mindclip weekly --week 2026-W23`,
    );

  mindclip
    .command('recordings')
    .description('List recordings for AI MindClip devices')
    .requiredOption('--device <id>', 'Device ID', stringArg('--device'))
    .requiredOption('--page <n>', 'Page number (>= 1)', intArg('--page', { min: 1 }))
    .requiredOption('--size <n>', 'Results per page (1-100)', intArg('--size', { min: 1, max: 100 }))
    .option('--start <ms>', 'Start timestamp in milliseconds', intArg('--start', { min: 0 }))
    .option('--end <ms>', 'End timestamp in milliseconds', intArg('--end', { min: 0 }))
    .option('--folder <n>', 'Folder ID', intArg('--folder', { min: 0 }))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip recordings --device AABBCCDDEEFF --page 2 --size 10`,
    )
    .action(async (options) => {
      const params = {
        deviceID: options.device,
        pageNum: Number(options.page),
        pageSize: Number(options.size),
        startTime: options.start,
        endTime: options.end,
        folderID: options.folder,
      };
      try {
        const data = await listRecordings(params);
        printJson(data);
      } catch (err) {
        handleError(err);
      }
    });

  mindclip
    .command('recording <id>')
    .description('Get details of a single recording')
    .option('--language <lang>', 'Legacy language filter; upstream support is unverified', stringArg('--language'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip recording 5f3a1c2e9b7d
  switchbot mindclip recording 5f3a1c2e9b7d --language en`,
    )
    .action(async (id: string, options) => {
      try {
        const data = await getRecording(id, options.language);
        printJson(data);
      } catch (err) {
        handleError(err);
      }
    });

  mindclip
    .command('transcript <id>')
    .description('Get the transcript and transcription status for a recording')
    .addHelpText(
      'after',
      `
The response is returned unchanged: transcribeStatus remains the upstream status
(1=in progress, 2=successful, 3=failed, 4=timed out, 5=speech-to-text failed),
and transcribeResult remains its original string alongside speakers.

Examples:
  switchbot mindclip transcript 5f3a1c2e9b7d`,
    )
    .action(async (id: string) => {
      try {
        const data = await getTranscript(id);
        printJson(data);
      } catch (err) {
        handleError(err);
      }
    });

  mindclip
    .command('summary <id>')
    .description('Get AI summary and transcription for a recording')
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip summary 5f3a1c2e9b7d`,
    )
    .action(async (id: string) => {
      try {
        const data = await getSummary(id);
        printJson(data);
      } catch (err) {
        handleError(err);
      }
    });

  mindclip
    .command('todos')
    .description('List AI-extracted to-do items')
    .requiredOption(
      '--completed <n>',
      'Completion filter (legacy range 0-2; upstream value meanings are unverified)',
      enumArg('--completed', ['0', '1', '2']),
    )
    .requiredOption('--page <n>', 'Page number (>= 1)', intArg('--page', { min: 1 }))
    .requiredOption('--size <n>', 'Results per page (1-100)', intArg('--size', { min: 1, max: 100 }))
    .option('--device <id>', 'Filter by device ID', stringArg('--device'))
    .option('--file <id>', 'Filter by recording file ID', stringArg('--file'))
    .option('--start <ms>', 'Start timestamp in milliseconds', intArg('--start', { min: 0 }))
    .option('--end <ms>', 'End timestamp in milliseconds', intArg('--end', { min: 0 }))
    .option(
      '--category <n>',
      'Legacy category filter (0-5); upstream support and value meanings are unverified',
      intArg('--category', { min: 0, max: 5 }),
    )
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip todos --completed 1 --page 1 --size 5`,
    )
    .action(async (options) => {
      const params = {
        completedNum: Number(options.completed),
        pageNum: Number(options.page),
        pageSize: Number(options.size),
        deviceID: options.device,
        fileID: options.file,
        startTime: options.start,
        endTime: options.end,
        category: options.category,
      };
      try {
        const data = await listTodos(params);
        printJson(data);
      } catch (err) {
        handleError(err);
      }
    });

  mindclip
    .command('daily')
    .description('Get daily recall summary for a date')
    .requiredOption('--date <YYYY-MM-DD>', 'Date', dateArg('--date'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip daily --date 2026-06-10`,
    )
    .action(async (options) => {
      try {
        const data = await getDailyRecall(options.date);
        printJson(data);
      } catch (err) {
        handleError(err);
      }
    });

  mindclip
    .command('weekly')
    .description('Get weekly summary for an ISO week')
    .requiredOption('--week <YYYY-Www>', 'ISO week', weekArg('--week'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip weekly --week 2026-W23`,
    )
    .action(async (options) => {
      try {
        const data = await getWeeklySummary(options.week);
        printJson(data);
      } catch (err) {
        handleError(err);
      }
    });

  mindclip
    .command('urgent-todos')
    .description('Get urgent to-dos for a date')
    .requiredOption('--date <YYYY-MM-DD>', 'Date', dateArg('--date'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip urgent-todos --date 2026-06-10`,
    )
    .action(async (options) => {
      try {
        const data = await getUrgentTodos(options.date);
        printJson(data);
      } catch (err) {
        handleError(err);
      }
    });
}
