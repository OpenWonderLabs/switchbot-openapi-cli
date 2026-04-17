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

  local top_cmds="config devices scenes webhook completion help"
  local config_sub="set-token show"
  local devices_sub="list status command types commands"
  local scenes_sub="list execute"
  local webhook_sub="setup query update delete"
  local completion_shells="bash zsh fish powershell"
  local global_opts="--json --verbose -v --dry-run --timeout --config --help -h --version -V"

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
  local -a top_cmds config_sub devices_sub scenes_sub webhook_sub completion_shells
  top_cmds=(
    'config:Manage API credentials'
    'devices:List and control devices'
    'scenes:List and execute scenes'
    'webhook:Manage webhook configuration'
    'completion:Print a shell completion script'
    'help:Show help for a command'
  )
  config_sub=('set-token:Save token + secret' 'show:Show current credential source')
  devices_sub=(
    'list:List all devices'
    'status:Query device status'
    'command:Send a control command'
    'types:List known device types (offline)'
    'commands:Show commands for a device type (offline)'
  )
  scenes_sub=('list:List manual scenes' 'execute:Run a scene')
  webhook_sub=(
    'setup:Register a webhook URL'
    'query:Query configured webhooks'
    'update:Enable/disable a webhook'
    'delete:Delete a webhook'
  )
  completion_shells=('bash' 'zsh' 'fish' 'powershell')

  local global_opts
  global_opts=(
    '--json[Raw JSON output]'
    '(-v --verbose)'{-v,--verbose}'[Log HTTP details to stderr]'
    '--dry-run[Print mutating requests without sending]'
    '--timeout[HTTP timeout in ms]:ms:'
    '--config[Override credential file path]:path:_files'
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
complete -c switchbot -s v -l verbose -d 'Log HTTP details to stderr'
complete -c switchbot -l dry-run     -d 'Print mutating requests without sending'
complete -c switchbot -l timeout  -r -d 'HTTP timeout in ms'
complete -c switchbot -l config   -r -d 'Credential file path'
complete -c switchbot -s h -l help -d 'Show help'
complete -c switchbot -s V -l version -d 'Show version'

# Top-level commands
complete -c switchbot -n '__fish_use_subcommand' -a 'config'     -d 'Manage API credentials'
complete -c switchbot -n '__fish_use_subcommand' -a 'devices'    -d 'List and control devices'
complete -c switchbot -n '__fish_use_subcommand' -a 'scenes'     -d 'List and execute scenes'
complete -c switchbot -n '__fish_use_subcommand' -a 'webhook'    -d 'Manage webhook configuration'
complete -c switchbot -n '__fish_use_subcommand' -a 'completion' -d 'Print a shell completion script'
complete -c switchbot -n '__fish_use_subcommand' -a 'help'       -d 'Show help'

# config
complete -c switchbot -n '__fish_seen_subcommand_from config' -a 'set-token show'

# devices
complete -c switchbot -n '__fish_seen_subcommand_from devices' -a 'list status command types commands'

# scenes
complete -c switchbot -n '__fish_seen_subcommand_from scenes' -a 'list execute'

# webhook
complete -c switchbot -n '__fish_seen_subcommand_from webhook' -a 'setup query update delete'
complete -c switchbot -n '__fish_seen_subcommand_from webhook; and __fish_seen_subcommand_from update' -l enable  -d 'Enable the webhook'
complete -c switchbot -n '__fish_seen_subcommand_from webhook; and __fish_seen_subcommand_from update' -l disable -d 'Disable the webhook'

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

  $top = 'config','devices','scenes','webhook','completion','help'
  $configSub = 'set-token','show'
  $devicesSub = 'list','status','command','types','commands'
  $scenesSub = 'list','execute'
  $webhookSub = 'setup','query','update','delete'
  $shells = 'bash','zsh','fish','powershell'
  $globalOpts = '--json','--verbose','-v','--dry-run','--timeout','--config','--help','-h','--version','-V'

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
