import { Command } from 'commander';
import { intArg, enumArg, stringArg, dateArg, weekArg } from '../utils/arg-parsers.js';
import { printJson, handleError } from '../utils/output.js';
import {
  listRecordings,
  getRecording,
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
  recordings      List recordings across all AI MindClip devices
  recording <id>  Get a single recording's metadata and transcript
  summary <id>    Get AI summary for a recording
  todos           List AI-extracted to-do items
  daily           Get daily recall summary
  weekly          Get weekly summary
  urgent-todos    Get urgent to-dos for a date

Examples:
  switchbot mindclip recordings --device AABBCCDDEEFF --size 10
  switchbot mindclip todos --completed 1
  switchbot mindclip daily --date 2026-06-10
  switchbot mindclip weekly`,
    );

  mindclip
    .command('recordings')
    .description('List recordings for AI MindClip devices')
    .option('--device <id>', 'Filter by device ID', stringArg('--device'))
    .option('--page <n>', 'Page number (>= 1)', intArg('--page', { min: 1 }))
    .option('--size <n>', 'Results per page (1-100)', intArg('--size', { min: 1, max: 100 }))
    .option('--start <ms>', 'Start timestamp in milliseconds', intArg('--start', { min: 0 }))
    .option('--end <ms>', 'End timestamp in milliseconds', intArg('--end', { min: 0 }))
    .option('--folder <n>', 'Folder ID', intArg('--folder', { min: 0 }))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip recordings
  switchbot mindclip recordings --device AABBCCDDEEFF --page 2 --size 10`,
    )
    .action(async (options) => {
      const params = Object.fromEntries(
        Object.entries({
          deviceID: options.device,
          pageNum: options.page !== undefined ? Number(options.page) : undefined,
          pageSize: options.size !== undefined ? Number(options.size) : undefined,
          startTime: options.start !== undefined ? Number(options.start) : undefined,
          endTime: options.end !== undefined ? Number(options.end) : undefined,
          folderID: options.folder !== undefined ? Number(options.folder) : undefined,
        }).filter(([, v]) => v !== undefined),
      );
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
    .option('--language <lang>', 'Language code for response (e.g. en, zh)', stringArg('--language'))
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
    .option(
      '--completed <n>',
      'Filter: 0=all, 1=incomplete, 2=completed [default: 0]',
      enumArg('--completed', ['0', '1', '2']),
    )
    .option('--page <n>', 'Page number (>= 1)', intArg('--page', { min: 1 }))
    .option('--size <n>', 'Results per page (1-100)', intArg('--size', { min: 1, max: 100 }))
    .option('--device <id>', 'Filter by device ID', stringArg('--device'))
    .option('--file <id>', 'Filter by recording file ID', stringArg('--file'))
    .option('--start <ms>', 'Start timestamp in milliseconds', intArg('--start', { min: 0 }))
    .option('--end <ms>', 'End timestamp in milliseconds', intArg('--end', { min: 0 }))
    .option(
      '--category <n>',
      'Category: 0=any, 1=work, 2=life, 3=hobby, 4=holiday, 5=other',
      intArg('--category', { min: 0, max: 5 }),
    )
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip todos
  switchbot mindclip todos --completed 1 --size 5
  switchbot mindclip todos --category 1`,
    )
    .action(async (options) => {
      const params = Object.fromEntries(
        Object.entries({
          completedNum: options.completed !== undefined ? Number(options.completed) : undefined,
          pageNum: options.page !== undefined ? Number(options.page) : undefined,
          pageSize: options.size !== undefined ? Number(options.size) : undefined,
          deviceID: options.device,
          fileID: options.file,
          startTime: options.start !== undefined ? Number(options.start) : undefined,
          endTime: options.end !== undefined ? Number(options.end) : undefined,
          category: options.category !== undefined ? Number(options.category) : undefined,
        }).filter(([, v]) => v !== undefined),
      );
      try {
        const data = await listTodos(params);
        printJson(data);
      } catch (err) {
        handleError(err);
      }
    });

  mindclip
    .command('daily')
    .description('Get daily recall summary (omit --date to get the most recent)')
    .option('--date <YYYY-MM-DD>', 'Date [default: most recent record on server]', dateArg('--date'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip daily
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
    .description('Get weekly summary (omit --week to get the most recent)')
    .option('--week <YYYY-Www>', 'ISO week [default: most recent record on server]', weekArg('--week'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip weekly
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
    .description("Get urgent to-dos for a date (omit --date to use yesterday's)")
    .option('--date <YYYY-MM-DD>', 'Date [default: yesterday on server]', dateArg('--date'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip urgent-todos
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
