export type ToolProfile = 'default' | 'readonly' | 'all';

const CORE_READ = [
  'list_devices',
  'get_device_status',
  'get_device_history',
  'query_device_history',
  'list_scenes',
  'search_catalog',
  'describe_device',
  'aggregate_device_history',
  'account_overview',
  'plan_suggest',
  'mindclip_list_recordings',
  'mindclip_get_recording',
  'mindclip_get_summary',
  'mindclip_list_todos',
  'mindclip_daily_recall',
  'mindclip_weekly_summary',
  'mindclip_urgent_todos',
] as const;

const CORE_ACTION = ['send_command', 'run_scene', 'plan_run'] as const;

const ADMIN = [
  'policy_validate',
  'policy_diff',
  'policy_new',
  'policy_migrate',
  'policy_add_rule',
  'audit_query',
  'audit_stats',
  'rule_notifications',
  'rules_suggest',
  'rules_explain',
  'rules_simulate',
] as const;

export const TOOL_PROFILES: Record<ToolProfile, ReadonlySet<string>> = {
  readonly: new Set(CORE_READ),
  default: new Set([...CORE_READ, ...CORE_ACTION]),
  all: new Set([...CORE_READ, ...CORE_ACTION, ...ADMIN]),
};

export const VALID_PROFILES = Object.keys(TOOL_PROFILES) as readonly ToolProfile[];

export function resolveToolProfile(name?: string): ToolProfile {
  if (!name || name === 'default') return 'default';
  if (name === 'readonly' || name === 'all') return name;
  const valid = VALID_PROFILES.join(', ');
  throw new Error(`Unknown tool profile "${name}". Valid profiles: ${valid}`);
}
