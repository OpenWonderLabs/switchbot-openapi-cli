import { Command } from 'commander';

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

  local top_cmds="config devices scenes webhook completion mcp quota catalog cache events doctor schema history plan capabilities help"
  local config_sub="set-token show list-profiles"
  local devices_sub="list ls status command types commands describe batch watch explain expand meta"
  local scenes_sub="list execute"
  local webhook_sub="setup query update delete"
  local events_sub="tail mqtt-tail"
  local quota_sub="status reset"
  local catalog_sub="path show diff refresh"
  local cache_sub="show clear"
  local history_sub="show replay"
  local plan_sub="schema validate run"
  local completion_shells="bash zsh fish powershell"
  local global_opts="--json --format --fields --verbose -v --dry-run --timeout --retry-on-429 --backoff --no-retry --no-quota --cache --no-cache --config --profile --audit-log --audit-log-path --help -h --version -V"

  if [[ \${cword} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${top_cmds} \${global_opts}" -- "\${cur}") )
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
        COMPREPLY=( $(compgen -W "command customize" -- "\${cur}") )
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
  local -a top_cmds config_sub devices_sub scenes_sub webhook_sub events_sub quota_sub catalog_sub cache_sub history_sub plan_sub completion_shells
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
    'help:Show help for a command'
  )
  config_sub=('set-token:Save token + secret' 'show:Show current credential source' 'list-profiles:List named credential profiles')
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
  scenes_sub=('list:List manual scenes' 'execute:Run a scene')
  webhook_sub=(
    'setup:Register a webhook URL'
    'query:Query configured webhooks'
    'update:Enable/disable a webhook'
    'delete:Delete a webhook'
  )
  events_sub=('tail:Run a local webhook receiver' 'mqtt-tail:Stream MQTT shadow events')
  quota_sub=('status:Show today and recent quota usage' 'reset:Delete the local quota counter')
  catalog_sub=('path:Show overlay path' 'show:Show built-in/overlay/effective catalog' 'diff:Show overlay changes' 'refresh:Clear overlay cache')
  cache_sub=('show:Summarize cache files' 'clear:Delete cache files')
  history_sub=('show:Print recent audit entries' 'replay:Re-run one audited command')
  plan_sub=('schema:Print the plan schema' 'validate:Validate a plan file' 'run:Validate and execute a plan')
  completion_shells=('bash' 'zsh' 'fish' 'powershell')

  local global_opts
  global_opts=(
    '--json[Raw JSON output]'
    '--format[Output format]:type:(table json jsonl tsv yaml id)'
    '--fields[Comma-separated output columns]:csv:'
    '(-v --verbose)'{-v,--verbose}'[Log HTTP details to stderr]'
    '--dry-run[Print mutating requests without sending]'
    '--timeout[HTTP timeout in ms]:ms:'
    '--retry-on-429[Max 429 retries]:n:'
    '--backoff[Retry backoff strategy]:strategy:(linear exponential)'
    '--no-retry[Disable 429 retries]'
    '--no-quota[Disable the local quota counter]'
    '--cache[Cache mode]:mode:'
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
      esac
      ;;
    rest)
      if [[ "$words[2]" == "webhook" && "$words[3]" == "update" ]]; then
        _values 'flag' '--enable' '--disable'
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
complete -c switchbot -l format   -r -d 'Output format'
complete -c switchbot -l fields   -r -d 'Comma-separated output columns'
complete -c switchbot -s v -l verbose -d 'Log HTTP details to stderr'
complete -c switchbot -l dry-run     -d 'Print mutating requests without sending'
complete -c switchbot -l timeout  -r -d 'HTTP timeout in ms'
complete -c switchbot -l retry-on-429 -r -d 'Max 429 retries'
complete -c switchbot -l backoff  -r -d 'Retry backoff strategy'
complete -c switchbot -l no-retry    -d 'Disable 429 retries'
complete -c switchbot -l no-quota    -d 'Disable the local quota counter'
complete -c switchbot -l cache    -r -d 'Cache mode'
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
complete -c switchbot -n '__fish_use_subcommand' -a 'help'       -d 'Show help'

# config
complete -c switchbot -n '__fish_seen_subcommand_from config' -a 'set-token show list-profiles'

# devices
complete -c switchbot -n '__fish_seen_subcommand_from devices' -a 'list ls status command types commands describe batch watch explain expand meta'

# scenes
complete -c switchbot -n '__fish_seen_subcommand_from scenes' -a 'list execute'

# webhook
complete -c switchbot -n '__fish_seen_subcommand_from webhook' -a 'setup query update delete'
complete -c switchbot -n '__fish_seen_subcommand_from webhook; and __fish_seen_subcommand_from update' -l enable  -d 'Enable the webhook'
complete -c switchbot -n '__fish_seen_subcommand_from webhook; and __fish_seen_subcommand_from update' -l disable -d 'Disable the webhook'

# events
complete -c switchbot -n '__fish_seen_subcommand_from events' -a 'tail mqtt-tail'

# quota
complete -c switchbot -n '__fish_seen_subcommand_from quota' -a 'status reset'

# catalog
complete -c switchbot -n '__fish_seen_subcommand_from catalog' -a 'path show diff refresh'

# cache
complete -c switchbot -n '__fish_seen_subcommand_from cache' -a 'show clear'

# history
complete -c switchbot -n '__fish_seen_subcommand_from history' -a 'show replay'

# plan
complete -c switchbot -n '__fish_seen_subcommand_from plan' -a 'schema validate run'

# completion
complete -c switchbot -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish powershell'
`;

const POWERSHELL_SCRIPT = `# switchbot PowerShell completion
# Install: switchbot completion powershell | Out-String | Invoke-Expression
# Or add to your profile:
#   switchbot completion powershell >> $PROFILE

Register-ArgumentCompleter -Native -CommandName switchbot -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  $count = $tokens.Count

  $top = 'config','devices','scenes','webhook','completion','mcp','quota','catalog','cache','events','doctor','schema','history','plan','capabilities','help'
  $configSub = 'set-token','show','list-profiles'
  $devicesSub = 'list','ls','status','command','types','commands','describe','batch','watch','explain','expand','meta'
  $scenesSub = 'list','execute'
  $webhookSub = 'setup','query','update','delete'
  $eventsSub = 'tail','mqtt-tail'
  $quotaSub = 'status','reset'
  $catalogSub = 'path','show','diff','refresh'
  $cacheSub = 'show','clear'
  $historySub = 'show','replay'
  $planSub = 'schema','validate','run'
  $shells = 'bash','zsh','fish','powershell'
  $globalOpts = '--json','--format','--fields','--verbose','-v','--dry-run','--timeout','--retry-on-429','--backoff','--no-retry','--no-quota','--cache','--no-cache','--config','--profile','--audit-log','--audit-log-path','--help','-h','--version','-V'

  function _emit($values) {
    $values |
      Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }

  if ($count -le 2) { return _emit ($top + $globalOpts) }

  switch ($tokens[1]) {
    'config'     { if ($count -eq 3) { return _emit $configSub } }
    'devices'    { if ($count -eq 3) { return _emit $devicesSub } }
    'scenes'     { if ($count -eq 3) { return _emit $scenesSub } }
    'events'     { if ($count -eq 3) { return _emit $eventsSub } }
    'quota'      { if ($count -eq 3) { return _emit $quotaSub } }
    'catalog'    { if ($count -eq 3) { return _emit $catalogSub } }
    'cache'      { if ($count -eq 3) { return _emit $cacheSub } }
    'history'    { if ($count -eq 3) { return _emit $historySub } }
    'plan'       { if ($count -eq 3) { return _emit $planSub } }
    'webhook'    {
      if ($count -eq 3) { return _emit $webhookSub }
      if ($tokens[2] -eq 'update') { return _emit ('--enable','--disable' + $globalOpts) }
    }
    'completion' { if ($count -eq 3) { return _emit $shells } }
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
