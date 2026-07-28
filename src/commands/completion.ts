import { Command } from 'commander';

const TOP_COMMANDS = [
  'config',
  'devices',
  'scenes',
  'webhook',
  'completion',
  'mcp',
  'quota',
  'catalog',
  'cache',
  'events',
  'doctor',
  'schema',
  'history',
  'plan',
  'capabilities',
  'agent-bootstrap',
  'policy',
  'rules',
  'auth',
  'install',
  'uninstall',
  'status-sync',
  'health',
  'upgrade-check',
  'daemon',
  'help',
] as const;

const CONFIG_SUBCOMMANDS = ['set-token', 'show', 'list-profiles', 'agent-profile'] as const;
const DEVICES_SUBCOMMANDS = ['list', 'ls', 'status', 'command', 'types', 'commands', 'describe', 'batch', 'watch', 'explain', 'expand', 'meta'] as const;
const SCENES_SUBCOMMANDS = ['list', 'execute', 'describe', 'validate', 'simulate', 'explain'] as const;
const WEBHOOK_SUBCOMMANDS = ['setup', 'query', 'update', 'delete'] as const;
const EVENTS_SUBCOMMANDS = ['tail', 'mqtt-tail'] as const;
const QUOTA_SUBCOMMANDS = ['status', 'reset'] as const;
const CATALOG_SUBCOMMANDS = ['path', 'show', 'search', 'diff', 'refresh'] as const;
const CACHE_SUBCOMMANDS = ['show', 'clear'] as const;
const HISTORY_SUBCOMMANDS = ['show', 'replay', 'range', 'stats', 'verify', 'aggregate'] as const;
const PLAN_SUBCOMMANDS = ['schema', 'validate', 'suggest', 'run', 'save', 'list', 'review', 'approve', 'execute'] as const;
const COMPLETION_SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
const GLOBAL_OPTIONS = [
  '--json',
  '--format',
  '--fields',
  '--table-style',
  '--verbose',
  '-v',
  '--dry-run',
  '--timeout',
  '--retry-on-429',
  '--backoff',
  '--no-retry',
  '--no-quota',
  '--cache',
  '--no-cache',
  '--config',
  '--profile',
  '--audit-log',
  '--audit-log-path',
  '--help',
  '-h',
  '--version',
  '-V',
] as const;

const FORMAT_VALUES = ['table', 'json', 'jsonl', 'tsv', 'yaml', 'id', 'markdown'] as const;
const TABLE_STYLE_VALUES = ['unicode', 'ascii', 'simple', 'markdown'] as const;
const BACKOFF_VALUES = ['linear', 'exponential'] as const;
const CACHE_VALUE_SUGGESTIONS = ['off', 'auto', '30s', '5m', '1h'] as const;
const COMMAND_TYPE_VALUES = ['command', 'customize'] as const;

const POLICY_SUBCOMMANDS = ['validate', 'new', 'migrate', 'diff', 'add-rule', 'backup', 'restore'] as const;
const RULES_SUBCOMMANDS = ['lint', 'list', 'run', 'tail', 'replay', 'reload', 'webhook-rotate-token', 'webhook-show-token', 'suggest', 'conflicts', 'doctor', 'summary', 'last-fired', 'explain', 'trace-explain', 'simulate'] as const;
const AUTH_SUBCOMMANDS = ['keychain'] as const;
const AUTH_KEYCHAIN_SUBCOMMANDS = ['describe', 'get', 'set', 'delete', 'migrate'] as const;
const STATUS_SYNC_SUBCOMMANDS = ['run', 'start', 'stop', 'status'] as const;
const DAEMON_SUBCOMMANDS = ['start', 'stop', 'status', 'reload'] as const;

function joinWords(values: readonly string[]): string {
  return values.join(' ');
}

function joinQuoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(' ');
}

function joinPsArray(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}

const BASH_SCRIPT = `# switchbot bash completion
# Install: source <(switchbot completion bash)
# Or add to ~/.bashrc:
#   source <(switchbot completion bash)

_switchbot_completion() {
  local cur prev words cword
  _get_comp_words_by_ref -n : cur prev words cword 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword="\${COMP_CWORD}"
  }

  local top_cmds="${joinWords(TOP_COMMANDS)}"
  local config_sub="${joinWords(CONFIG_SUBCOMMANDS)}"
  local devices_sub="${joinWords(DEVICES_SUBCOMMANDS)}"
  local scenes_sub="${joinWords(SCENES_SUBCOMMANDS)}"
  local webhook_sub="${joinWords(WEBHOOK_SUBCOMMANDS)}"
  local events_sub="${joinWords(EVENTS_SUBCOMMANDS)}"
  local quota_sub="${joinWords(QUOTA_SUBCOMMANDS)}"
  local catalog_sub="${joinWords(CATALOG_SUBCOMMANDS)}"
  local cache_sub="${joinWords(CACHE_SUBCOMMANDS)}"
  local history_sub="${joinWords(HISTORY_SUBCOMMANDS)}"
  local plan_sub="${joinWords(PLAN_SUBCOMMANDS)}"
  local completion_shells="${joinWords(COMPLETION_SHELLS)}"
  local policy_sub="${joinWords(POLICY_SUBCOMMANDS)}"
  local rules_sub="${joinWords(RULES_SUBCOMMANDS)}"
  local auth_sub="${joinWords(AUTH_SUBCOMMANDS)}"
  local auth_keychain_sub="${joinWords(AUTH_KEYCHAIN_SUBCOMMANDS)}"
  local status_sync_sub="${joinWords(STATUS_SYNC_SUBCOMMANDS)}"
  local daemon_sub="${joinWords(DAEMON_SUBCOMMANDS)}"
  local format_vals="${joinWords(FORMAT_VALUES)}"
  local global_opts="${joinWords(GLOBAL_OPTIONS)}"

  if [[ \${cword} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${top_cmds} \${global_opts}" -- "\${cur}") )
    return
  fi

  if [[ "\${prev}" == "--format" || "\${prev}" == "--table-style" ]]; then
    local vals="\${format_vals}"
    [[ "\${prev}" == "--table-style" ]] && vals="${joinWords(TABLE_STYLE_VALUES)}"
    COMPREPLY=( $(compgen -W "\${vals}" -- "\${cur}") )
    return
  fi

  if [[ "\${prev}" == "--backoff" ]]; then
    COMPREPLY=( $(compgen -W "${joinWords(BACKOFF_VALUES)}" -- "\${cur}") )
    return
  fi

  if [[ "\${prev}" == "--cache" ]]; then
    COMPREPLY=( $(compgen -W "${joinWords(CACHE_VALUE_SUGGESTIONS)}" -- "\${cur}") )
    return
  fi

  case "\${words[1]}" in
    config)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${config_sub}" -- "\${cur}") )
      fi
      ;;
    devices)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${devices_sub}" -- "\${cur}") )
      elif [[ "\${words[2]}" == "command" && "\${prev}" == "--type" ]]; then
        COMPREPLY=( $(compgen -W "${joinWords(COMMAND_TYPE_VALUES)}" -- "\${cur}") )
      fi
      ;;
    scenes)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${scenes_sub}" -- "\${cur}") )
      fi
      ;;
    events)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${events_sub}" -- "\${cur}") )
      fi
      ;;
    quota)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${quota_sub}" -- "\${cur}") )
      fi
      ;;
    catalog)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${catalog_sub}" -- "\${cur}") )
      fi
      ;;
    cache)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${cache_sub}" -- "\${cur}") )
      fi
      ;;
    history)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${history_sub}" -- "\${cur}") )
      fi
      ;;
    plan)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${plan_sub}" -- "\${cur}") )
      fi
      ;;
    webhook)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${webhook_sub}" -- "\${cur}") )
      elif [[ "\${words[2]}" == "update" ]]; then
        COMPREPLY=( $(compgen -W "--enable --disable \${global_opts}" -- "\${cur}") )
      fi
      ;;
    completion)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${completion_shells}" -- "\${cur}") )
      fi
      ;;
    policy)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${policy_sub}" -- "\${cur}") )
      fi
      ;;
    rules)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${rules_sub}" -- "\${cur}") )
      fi
      ;;
    auth)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${auth_sub}" -- "\${cur}") )
      elif [[ "\${words[2]}" == "keychain" && \${cword} -eq 3 ]]; then
        COMPREPLY=( $(compgen -W "\${auth_keychain_sub}" -- "\${cur}") )
      fi
      ;;
    status-sync)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${status_sync_sub}" -- "\${cur}") )
      fi
      ;;
    daemon)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "\${daemon_sub}" -- "\${cur}") )
      fi
      ;;
    *)
      COMPREPLY=( $(compgen -W "\${global_opts}" -- "\${cur}") )
      ;;
  esac
}

complete -F _switchbot_completion switchbot
`;

const ZSH_SCRIPT = `# switchbot zsh completion
# Install: source <(switchbot completion zsh)
# Or add to ~/.zshrc:
#   source <(switchbot completion zsh)

_switchbot() {
  local -a top_cmds config_sub devices_sub scenes_sub webhook_sub events_sub quota_sub catalog_sub cache_sub history_sub plan_sub completion_shells policy_sub rules_sub auth_sub auth_keychain_sub status_sync_sub daemon_sub
  top_cmds=(
    'config:Manage API credentials'
    'devices:List and control devices'
    'scenes:List and execute scenes'
    'webhook:Manage webhook configuration'
    'completion:Print a shell completion script'
    'mcp:Run the MCP server'
    'quota:Inspect local request quota'
    'catalog:Inspect the built-in device catalog'
    'cache:Inspect local caches'
    'events:Receive webhook or MQTT events'
    'doctor:Run self-checks'
    'schema:Export the device catalog as JSON'
    'history:View and replay audited commands'
    'plan:Validate and run batch plans'
    'capabilities:Print a machine-readable manifest'
    'agent-bootstrap:Print bootstrap info for AI agents'
    'policy:Validate scaffold and migrate policy.yaml'
    'rules:Inspect and simulate automation rules'
    'auth:Manage keychain-backed credentials'
    'install:Bootstrap SwitchBot CLI setup'
    'uninstall:Remove SwitchBot CLI setup'
    'status-sync:Bridge MQTT shadow updates'
    'health:Report runtime health'
    'upgrade-check:Check release notes before upgrading'
    'daemon:Run the background rules engine'
    'help:Show help for a command'
  )
  config_sub=('set-token:Save token + secret' 'show:Show current credential source' 'list-profiles:List named credential profiles' 'agent-profile:Print agent-oriented profile details')
  devices_sub=(
    'list:List all devices'
    'ls:Alias for list'
    'status:Query device status'
    'command:Send a control command'
    'types:List known device types (offline)'
    'commands:Show commands for a device type (offline)'
    'describe:Show metadata + supported commands for one device'
    'batch:Send one command to many devices'
    'watch:Poll device status and emit changes'
    'explain:One-shot device summary'
    'expand:Build wire-format params from semantic flags'
    'meta:Manage local device metadata'
  )
  scenes_sub=('list:List manual scenes' 'execute:Run a scene' 'describe:Show one scene' 'validate:Check whether a scene id exists' 'simulate:Dry-run a scene invocation' 'explain:Show a human-readable scene summary')
  webhook_sub=(
    'setup:Register a webhook URL'
    'query:Query configured webhooks'
    'update:Enable/disable a webhook'
    'delete:Delete a webhook'
  )
  events_sub=('tail:Run a local webhook receiver' 'mqtt-tail:Stream MQTT shadow events')
  quota_sub=('status:Show today and recent quota usage' 'reset:Delete the local quota counter')
  catalog_sub=('path:Show overlay path' 'show:Show built-in/overlay/effective catalog' 'search:Search the effective catalog' 'diff:Show overlay changes' 'refresh:Clear overlay cache')
  cache_sub=('show:Summarize cache files' 'clear:Delete cache files')
  history_sub=('show:Print recent audit entries' 'replay:Re-run one audited command' 'range:Query a time range' 'stats:Aggregate audit results' 'verify:Verify audit log integrity' 'aggregate:Aggregate audit fields')
  plan_sub=('schema:Print the plan schema' 'validate:Validate a plan file' 'suggest:Draft a plan from intent + devices' 'run:Validate and execute a plan' 'save:Save a plan for approval' 'list:List saved plans' 'review:Inspect a saved plan' 'approve:Approve a saved plan' 'execute:Run an approved plan')
  completion_shells=(${joinQuoted(COMPLETION_SHELLS)})
  policy_sub=(${joinQuoted(POLICY_SUBCOMMANDS)})
  rules_sub=(${joinQuoted(RULES_SUBCOMMANDS)})
  auth_sub=(${joinQuoted(AUTH_SUBCOMMANDS)})
  auth_keychain_sub=(${joinQuoted(AUTH_KEYCHAIN_SUBCOMMANDS)})
  status_sync_sub=(${joinQuoted(STATUS_SYNC_SUBCOMMANDS)})
  daemon_sub=(${joinQuoted(DAEMON_SUBCOMMANDS)})

  local global_opts
  global_opts=(
    '--json[Raw JSON output]'
    '--format[Output format]:type:(${joinWords(FORMAT_VALUES)})'
    '--fields[Comma-separated output columns]:csv:'
    '--table-style[Table rendering style]:style:(${joinWords(TABLE_STYLE_VALUES)})'
    '(-v --verbose)'{-v,--verbose}'[Log HTTP details to stderr]'
    '--dry-run[Print mutating requests without sending]'
    '--timeout[HTTP timeout in ms]:ms:'
    '--retry-on-429[Max 429 retries]:n:'
    '--backoff[Retry backoff strategy]:strategy:(${joinWords(BACKOFF_VALUES)})'
    '--no-retry[Disable 429 retries]'
    '--no-quota[Disable the local quota counter]'
    '--cache[Cache mode]:mode:(${joinWords(CACHE_VALUE_SUGGESTIONS)})'
    '--no-cache[Disable cache reads]'
    '--config[Override credential file path]:path:_files'
    '--profile[Use a named credential profile]:name:'
    '--audit-log[Append mutating commands to ~/.switchbot/audit.log]'
    '--audit-log-path[Custom audit log file path]:path:_files'
    '(-h --help)'{-h,--help}'[Show help]'
    '(-V --version)'{-V,--version}'[Show version]'
  )

  _arguments -C \\
    "1:command:->top" \\
    "2:subcommand:->sub" \\
    "*::arg:->rest" \\
    $global_opts

  case "$state" in
    top)
      _describe 'command' top_cmds
      ;;
    sub)
      case "$words[2]" in
        config)     _describe 'config'     config_sub ;;
        devices)    _describe 'devices'    devices_sub ;;
        scenes)     _describe 'scenes'     scenes_sub ;;
        webhook)    _describe 'webhook'    webhook_sub ;;
        events)     _describe 'events'     events_sub ;;
        quota)      _describe 'quota'      quota_sub ;;
        catalog)    _describe 'catalog'    catalog_sub ;;
        cache)      _describe 'cache'      cache_sub ;;
        history)    _describe 'history'    history_sub ;;
        plan)       _describe 'plan'       plan_sub ;;
        completion) _values 'shell' $completion_shells ;;
        policy) _describe 'policy' policy_sub ;;
        rules) _describe 'rules' rules_sub ;;
        auth) _describe 'auth' auth_sub ;;
        status-sync) _describe 'status-sync' status_sync_sub ;;
        daemon) _describe 'daemon' daemon_sub ;;
      esac
      ;;
    rest)
      if [[ "$words[2]" == "webhook" && "$words[3]" == "update" ]]; then
        _values 'flag' '--enable' '--disable'
      elif [[ "$words[2]" == "auth" && "$words[3]" == "keychain" ]]; then
        _describe 'auth keychain' auth_keychain_sub
      fi
      ;;
  esac
}

compdef _switchbot switchbot
`;

const FISH_SCRIPT = `# switchbot fish completion
# Install:
#   switchbot completion fish > ~/.config/fish/completions/switchbot.fish

complete -c switchbot -f

# Global options
complete -c switchbot -l json        -d 'Raw JSON output'
complete -c switchbot -l format   -r -a '${joinWords(FORMAT_VALUES)}' -d 'Output format'
complete -c switchbot -l fields   -r -d 'Comma-separated output columns'
complete -c switchbot -l table-style -r -a '${joinWords(TABLE_STYLE_VALUES)}' -d 'Table rendering style'
complete -c switchbot -s v -l verbose -d 'Log HTTP details to stderr'
complete -c switchbot -l dry-run     -d 'Print mutating requests without sending'
complete -c switchbot -l timeout  -r -d 'HTTP timeout in ms'
complete -c switchbot -l retry-on-429 -r -d 'Max 429 retries'
complete -c switchbot -l backoff  -r -a '${joinWords(BACKOFF_VALUES)}' -d 'Retry backoff strategy'
complete -c switchbot -l no-retry    -d 'Disable 429 retries'
complete -c switchbot -l no-quota    -d 'Disable the local quota counter'
complete -c switchbot -l cache    -r -a '${joinWords(CACHE_VALUE_SUGGESTIONS)}' -d 'Cache mode'
complete -c switchbot -l no-cache    -d 'Disable cache reads'
complete -c switchbot -l config   -r -d 'Credential file path'
complete -c switchbot -l profile  -r -d 'Named credential profile'
complete -c switchbot -l audit-log -d 'Append mutating commands to audit log'
complete -c switchbot -l audit-log-path -r -d 'Custom audit log file path'
complete -c switchbot -s h -l help -d 'Show help'
complete -c switchbot -s V -l version -d 'Show version'

# Top-level commands
complete -c switchbot -n '__fish_use_subcommand' -a 'config'     -d 'Manage API credentials'
complete -c switchbot -n '__fish_use_subcommand' -a 'devices'    -d 'List and control devices'
complete -c switchbot -n '__fish_use_subcommand' -a 'scenes'     -d 'List and execute scenes'
complete -c switchbot -n '__fish_use_subcommand' -a 'webhook'    -d 'Manage webhook configuration'
complete -c switchbot -n '__fish_use_subcommand' -a 'completion' -d 'Print a shell completion script'
complete -c switchbot -n '__fish_use_subcommand' -a 'mcp'        -d 'Run the MCP server'
complete -c switchbot -n '__fish_use_subcommand' -a 'quota'      -d 'Inspect local request quota'
complete -c switchbot -n '__fish_use_subcommand' -a 'catalog'    -d 'Inspect the built-in device catalog'
complete -c switchbot -n '__fish_use_subcommand' -a 'cache'      -d 'Inspect local caches'
complete -c switchbot -n '__fish_use_subcommand' -a 'events'     -d 'Receive webhook or MQTT events'
complete -c switchbot -n '__fish_use_subcommand' -a 'doctor'     -d 'Run self-checks'
complete -c switchbot -n '__fish_use_subcommand' -a 'schema'     -d 'Export the device catalog as JSON'
complete -c switchbot -n '__fish_use_subcommand' -a 'history'    -d 'View and replay audited commands'
complete -c switchbot -n '__fish_use_subcommand' -a 'plan'       -d 'Validate and run batch plans'
complete -c switchbot -n '__fish_use_subcommand' -a 'capabilities' -d 'Print a machine-readable manifest'
complete -c switchbot -n '__fish_use_subcommand' -a 'agent-bootstrap' -d 'Print bootstrap info for AI agents'
complete -c switchbot -n '__fish_use_subcommand' -a 'policy'     -d 'Validate scaffold and migrate policy.yaml'
complete -c switchbot -n '__fish_use_subcommand' -a 'rules'      -d 'Inspect and simulate automation rules'
complete -c switchbot -n '__fish_use_subcommand' -a 'auth'       -d 'Manage keychain-backed credentials'
complete -c switchbot -n '__fish_use_subcommand' -a 'install'    -d 'Bootstrap SwitchBot CLI setup'
complete -c switchbot -n '__fish_use_subcommand' -a 'uninstall'  -d 'Remove SwitchBot CLI setup'
complete -c switchbot -n '__fish_use_subcommand' -a 'status-sync' -d 'Bridge MQTT shadow updates'
complete -c switchbot -n '__fish_use_subcommand' -a 'health'     -d 'Report runtime health'
complete -c switchbot -n '__fish_use_subcommand' -a 'upgrade-check' -d 'Check release notes before upgrading'
complete -c switchbot -n '__fish_use_subcommand' -a 'daemon'     -d 'Run the background rules engine'
complete -c switchbot -n '__fish_use_subcommand' -a 'help'       -d 'Show help'

# config
complete -c switchbot -n '__fish_seen_subcommand_from config' -a '${joinWords(CONFIG_SUBCOMMANDS)}'

# devices
complete -c switchbot -n '__fish_seen_subcommand_from devices' -a '${joinWords(DEVICES_SUBCOMMANDS)}'
complete -c switchbot -n '__fish_seen_subcommand_from devices; and __fish_seen_subcommand_from command' -l type -r -a '${joinWords(COMMAND_TYPE_VALUES)}' -d 'Command type'

# scenes
complete -c switchbot -n '__fish_seen_subcommand_from scenes' -a '${joinWords(SCENES_SUBCOMMANDS)}'

# webhook
complete -c switchbot -n '__fish_seen_subcommand_from webhook' -a '${joinWords(WEBHOOK_SUBCOMMANDS)}'
complete -c switchbot -n '__fish_seen_subcommand_from webhook; and __fish_seen_subcommand_from update' -l enable  -d 'Enable the webhook'
complete -c switchbot -n '__fish_seen_subcommand_from webhook; and __fish_seen_subcommand_from update' -l disable -d 'Disable the webhook'

# events
complete -c switchbot -n '__fish_seen_subcommand_from events' -a '${joinWords(EVENTS_SUBCOMMANDS)}'

# quota
complete -c switchbot -n '__fish_seen_subcommand_from quota' -a '${joinWords(QUOTA_SUBCOMMANDS)}'

# catalog
complete -c switchbot -n '__fish_seen_subcommand_from catalog' -a '${joinWords(CATALOG_SUBCOMMANDS)}'

# cache
complete -c switchbot -n '__fish_seen_subcommand_from cache' -a '${joinWords(CACHE_SUBCOMMANDS)}'

# history
complete -c switchbot -n '__fish_seen_subcommand_from history' -a '${joinWords(HISTORY_SUBCOMMANDS)}'

# plan
complete -c switchbot -n '__fish_seen_subcommand_from plan' -a '${joinWords(PLAN_SUBCOMMANDS)}'

# completion
complete -c switchbot -n '__fish_seen_subcommand_from completion' -a '${joinWords(COMPLETION_SHELLS)}'

# policy
complete -c switchbot -n '__fish_seen_subcommand_from policy' -a '${joinWords(POLICY_SUBCOMMANDS)}'

# rules
complete -c switchbot -n '__fish_seen_subcommand_from rules' -a '${joinWords(RULES_SUBCOMMANDS)}'

# auth
complete -c switchbot -n '__fish_seen_subcommand_from auth' -a '${joinWords(AUTH_SUBCOMMANDS)}'
complete -c switchbot -n '__fish_seen_subcommand_from auth; and __fish_seen_subcommand_from keychain' -a '${joinWords(AUTH_KEYCHAIN_SUBCOMMANDS)}'

# status-sync
complete -c switchbot -n '__fish_seen_subcommand_from status-sync' -a '${joinWords(STATUS_SYNC_SUBCOMMANDS)}'

# daemon
complete -c switchbot -n '__fish_seen_subcommand_from daemon' -a '${joinWords(DAEMON_SUBCOMMANDS)}'
`;

const POWERSHELL_SCRIPT = `# switchbot PowerShell completion
# Install: switchbot completion powershell | Out-String | Invoke-Expression
# Or add to your profile:
#   switchbot completion powershell >> $PROFILE

Register-ArgumentCompleter -Native -CommandName switchbot -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  $count = $tokens.Count
  $lastToken = if ($count -gt 0) { $tokens[$count - 1] } else { '' }
  $prev = if ($wordToComplete -and $lastToken -eq $wordToComplete -and $count -ge 2) { $tokens[$count - 2] } else { $lastToken }

  $top = ${joinPsArray(TOP_COMMANDS)}
  $configSub = ${joinPsArray(CONFIG_SUBCOMMANDS)}
  $devicesSub = ${joinPsArray(DEVICES_SUBCOMMANDS)}
  $scenesSub = ${joinPsArray(SCENES_SUBCOMMANDS)}
  $webhookSub = ${joinPsArray(WEBHOOK_SUBCOMMANDS)}
  $eventsSub = ${joinPsArray(EVENTS_SUBCOMMANDS)}
  $quotaSub = ${joinPsArray(QUOTA_SUBCOMMANDS)}
  $catalogSub = ${joinPsArray(CATALOG_SUBCOMMANDS)}
  $cacheSub = ${joinPsArray(CACHE_SUBCOMMANDS)}
  $historySub = ${joinPsArray(HISTORY_SUBCOMMANDS)}
  $planSub = ${joinPsArray(PLAN_SUBCOMMANDS)}
  $shells = ${joinPsArray(COMPLETION_SHELLS)}
  $policySub = ${joinPsArray(POLICY_SUBCOMMANDS)}
  $rulesSub = ${joinPsArray(RULES_SUBCOMMANDS)}
  $authSub = ${joinPsArray(AUTH_SUBCOMMANDS)}
  $authKeychainSub = ${joinPsArray(AUTH_KEYCHAIN_SUBCOMMANDS)}
  $statusSyncSub = ${joinPsArray(STATUS_SYNC_SUBCOMMANDS)}
  $daemonSub = ${joinPsArray(DAEMON_SUBCOMMANDS)}
  $formatVals = ${joinPsArray(FORMAT_VALUES)}
  $tableStyleVals = ${joinPsArray(TABLE_STYLE_VALUES)}
  $backoffVals = ${joinPsArray(BACKOFF_VALUES)}
  $cacheVals = ${joinPsArray(CACHE_VALUE_SUGGESTIONS)}
  $commandTypeVals = ${joinPsArray(COMMAND_TYPE_VALUES)}
  $globalOpts = ${joinPsArray(GLOBAL_OPTIONS)}

  function _emit($values) {
    $values |
      Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }

  # Value completions must come before the $count guard: after "switchbot --format <Tab>"
  # the empty wordToComplete is absent from CommandElements, so $count stays 2 and
  # the guard would fire first, swallowing these completions.
  if ($prev -eq '--format') { return _emit $formatVals }
  if ($prev -eq '--table-style') { return _emit $tableStyleVals }
  if ($prev -eq '--backoff') { return _emit $backoffVals }
  if ($prev -eq '--cache') { return _emit $cacheVals }
  # Two conditions handle auth keychain completions:
  # 1. Below (before $count guard): trailing-space case — empty wordToComplete absent from
  #    CommandElements keeps $count at 3, so this fires when cursor is after "keychain ".
  # 2. Inside the switch ('auth' branch): partial-word case — $count is 4 and $tokens[3]
  #    is the in-progress word.  The two conditions are mutually exclusive.
  if ($tokens[1] -eq 'auth' -and $prev -eq 'keychain') { return _emit $authKeychainSub }

  if ($count -le 2) { return _emit ($top + $globalOpts) }

  switch ($tokens[1]) {
    'config'     { if ($count -eq 3) { return _emit $configSub } }
    'devices'    {
      if ($count -eq 3) { return _emit $devicesSub }
      if ($tokens[2] -eq 'command' -and $prev -eq '--type') { return _emit $commandTypeVals }
    }
    'scenes'     { if ($count -eq 3) { return _emit $scenesSub } }
    'events'     { if ($count -eq 3) { return _emit $eventsSub } }
    'quota'      { if ($count -eq 3) { return _emit $quotaSub } }
    'catalog'    { if ($count -eq 3) { return _emit $catalogSub } }
    'cache'      { if ($count -eq 3) { return _emit $cacheSub } }
    'history'    { if ($count -eq 3) { return _emit $historySub } }
    'plan'       { if ($count -eq 3) { return _emit $planSub } }
    'webhook'    {
      if ($count -eq 3) { return _emit $webhookSub }
      if ($tokens[2] -eq 'update') { return _emit (('--enable','--disable') + $globalOpts) }
    }
    'completion' { if ($count -eq 3) { return _emit $shells } }
    'policy'     { if ($count -eq 3) { return _emit $policySub } }
    'rules'      { if ($count -eq 3) { return _emit $rulesSub } }
    'auth'       {
      if ($count -eq 3) { return _emit $authSub }
      if ($tokens[2] -eq 'keychain' -and $count -eq 4) { return _emit $authKeychainSub }
    }
    'status-sync' { if ($count -eq 3) { return _emit $statusSyncSub } }
    'daemon'     { if ($count -eq 3) { return _emit $daemonSub } }
  }

  return _emit $globalOpts
}
`;

export function registerCompletionCommand(program: Command): void {
  const completion = program
    .command('completion')
    .description('Print a shell completion script for bash, zsh, fish, or powershell')
    .argument('<shell>', 'Shell to generate completion for: bash | zsh | fish | powershell')
    .addHelpText('after', `
The command writes the completion script to stdout. Redirect it to a file or
source it directly:

  bash       source <(switchbot completion bash)
             # persist: echo 'source <(switchbot completion bash)' >> ~/.bashrc

  zsh        source <(switchbot completion zsh)
             # persist: echo 'source <(switchbot completion zsh)' >> ~/.zshrc

  fish       switchbot completion fish > ~/.config/fish/completions/switchbot.fish

  powershell switchbot completion powershell | Out-String | Invoke-Expression
             # persist: switchbot completion powershell >> $PROFILE
`)
    .action((shell: string) => {
      switch (shell.toLowerCase()) {
        case 'bash':
          process.stdout.write(BASH_SCRIPT);
          return;
        case 'zsh':
          process.stdout.write(ZSH_SCRIPT);
          return;
        case 'fish':
          process.stdout.write(FISH_SCRIPT);
          return;
        case 'powershell':
        case 'pwsh':
          process.stdout.write(POWERSHELL_SCRIPT);
          return;
        default:
          completion.error(
            `error: unsupported shell "${shell}" (choose from: bash, zsh, fish, powershell)`,
            { exitCode: 2, code: 'switchbot.unsupportedShell' }
          );
      }
    });
}
