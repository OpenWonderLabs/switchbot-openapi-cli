import { Command } from 'commander';
import { exitWithError, isJsonMode } from '../utils/output.js';

const SHELLS = ['bash', 'zsh', 'fish', 'powershell', 'pwsh'];
const VALUE_CHOICES: Record<string, readonly string[]> = {
  '--format': ['table', 'json', 'jsonl', 'tsv', 'yaml', 'id', 'markdown'],
  '--table-style': ['unicode', 'ascii', 'simple', 'markdown'],
  '--backoff': ['linear', 'exponential'],
  '--cache': ['off', 'auto', '30s', '5m', '1h'],
  '--type': ['command', 'customize'],
};

interface CompletionContext {
  path: string;
  choices: string[];
}

interface CompletionDirectory {
  contexts: CompletionContext[];
  valueFlags: string[];
}

function completionDirectory(program: Command): CompletionDirectory {
  const contexts: CompletionContext[] = [];
  const valueFlags = new Set<string>();
  function visit(command: Command, path: string[], inheritedFlags: readonly string[]): void {
    const flags = [...inheritedFlags];
    for (const option of command.options) {
      for (const flag of [option.short, option.long]) {
        if (!flag) continue;
        flags.push(flag);
        if (option.required || option.optional) valueFlags.add(flag);
      }
    }
    flags.push('-h', '--help');
    const names = command.commands.flatMap((child) => [child.name(), ...child.aliases()]);
    if (path.length === 0) names.push('help');
    if (path.join(' ') === 'completion') names.push(...SHELLS);
    contexts.push({ path: path.join(' '), choices: [...new Set([...names, ...flags])] });
    for (const child of command.commands) {
      for (const name of [child.name(), ...child.aliases()]) visit(child, [...path, name], flags);
    }
  }
  visit(program, [], []);
  return { contexts, valueFlags: [...valueFlags] };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function bashScript(directory: CompletionDirectory): string {
  const paths = directory.contexts.filter((context) => context.path).map((context) => shellQuote(context.path)).join('|');
  const valueFlags = directory.valueFlags.map(shellQuote).join('|') || "'--'";
  return `# switchbot bash completion
# Install: source <(switchbot completion bash)
_switchbot_completion() {
  local cur prev words cword
  _get_comp_words_by_ref -n : cur prev words cword 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword="\${COMP_CWORD}"
  }
  local choices='' context='' next word skip=0 i
  case "$prev" in
${Object.entries(VALUE_CHOICES).map(([flag, choices]) => `    ${shellQuote(flag)}) COMPREPLY=( $(compgen -W ${shellQuote(choices.join(' '))} -- "$cur") ); return ;;`).join('\n')}
  esac
  for ((i=1; i<cword; i++)); do
    word="\${words[i]}"
    if ((skip)); then skip=0; continue; fi
    case "$word" in
      --*=*) continue ;;
      ${valueFlags}) skip=1; continue ;;
      -*) continue ;;
    esac
    next="\${context:+$context }$word"
    case "$next" in ${paths}) context="$next" ;; esac
  done
  case "$context" in
${directory.contexts.map((context) => `    ${shellQuote(context.path)}) choices=${shellQuote(context.choices.join(' '))} ;;`).join('\n')}
  esac
  COMPREPLY=( $(compgen -W "$choices" -- "$cur") )
}
complete -F _switchbot_completion switchbot
`;
}

function zshScript(directory: CompletionDirectory): string {
  const paths = directory.contexts.filter((context) => context.path).map((context) => shellQuote(context.path)).join('|');
  const valueFlags = directory.valueFlags.map(shellQuote).join('|') || "'--'";
  return `# switchbot zsh completion
# Install: source <(switchbot completion zsh)
_switchbot() {
  local context='' next word prev="\${words[CURRENT-1]}"
  local -a candidates
  integer skip=0 i
  case "$prev" in
${Object.entries(VALUE_CHOICES).map(([flag, choices]) => `    ${shellQuote(flag)}) candidates=(${choices.map(shellQuote).join(' ')}); compadd -a candidates; return ;;`).join('\n')}
  esac
  for ((i=2; i<CURRENT; i++)); do
    word="\${words[i]}"
    if ((skip)); then skip=0; continue; fi
    case "$word" in
      --*=*) continue ;;
      ${valueFlags}) skip=1; continue ;;
      -*) continue ;;
    esac
    next="\${context:+$context }$word"
    case "$next" in ${paths}) context="$next" ;; esac
  done
  case "$context" in
${directory.contexts.map((context) => `    ${shellQuote(context.path)}) candidates=(${context.choices.map(shellQuote).join(' ')}) ;;`).join('\n')}
  esac
  compadd -a candidates
}
compdef _switchbot switchbot
`;
}

function fishScript(directory: CompletionDirectory): string {
  return `# switchbot fish completion
# Install: switchbot completion fish > ~/.config/fish/completions/switchbot.fish
function _switchbot_candidates
  set -l words (commandline -opc)
  set -l current (commandline -ct)
  if test -n "$current"; and test "$words[-1]" = "$current"
    set -e words[-1]
  end
  set -l prev $words[-1]
  switch "$prev"
${Object.entries(VALUE_CHOICES).map(([flag, choices]) => `    case ${shellQuote(flag)}\n      printf '%s\\n' ${choices.map(shellQuote).join(' ')}\n      return`).join('\n')}
  end
  set -e words[1]
  set -l context ''
  set -l skip 0
  for word in $words
    if test $skip -eq 1
      set skip 0
      continue
    end
    switch "$word"
      case '--*=*'
        continue
      case ${directory.valueFlags.map(shellQuote).join(' ') || "'--'"}
        set skip 1
        continue
      case '-*'
        continue
    end
    set -l next "$word"
    if test -n "$context"
      set next "$context $word"
    end
    switch "$next"
      case ${directory.contexts.filter((context) => context.path).map((context) => shellQuote(context.path)).join(' ')}
        set context "$next"
    end
  end
  switch "$context"
${directory.contexts.map((context) => `    case ${shellQuote(context.path)}\n      printf '%s\\n' ${context.choices.map(shellQuote).join(' ')}`).join('\n')}
  end
end
complete -c switchbot -f -a '(_switchbot_candidates)'
`;
}

function powershellScript(directory: CompletionDirectory): string {
  return `# switchbot PowerShell completion
# Install: switchbot completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName switchbot -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  if ($wordToComplete -and $tokens.Count -gt 1 -and $tokens[-1] -eq $wordToComplete) {
    $tokens = @($tokens[0..($tokens.Count - 2)])
  }
  $prev = if ($tokens.Count -gt 1) { $tokens[-1] } else { '' }
  $choices = @()
  switch ($prev) {
${Object.entries(VALUE_CHOICES).map(([flag, choices]) => `    ${psQuote(flag)} { $choices = @(${choices.map(psQuote).join(',')}); break }`).join('\n')}
  }
  if ($choices.Count -eq 0) {
    $context = ''
    $skip = $false
    $valueFlags = @(${directory.valueFlags.map(psQuote).join(',')})
    $paths = @(${directory.contexts.filter((context) => context.path).map((context) => psQuote(context.path)).join(',')})
    foreach ($word in ($tokens | Select-Object -Skip 1)) {
      if ($skip) { $skip = $false; continue }
      if ($word -like '--*=*') { continue }
      if ($valueFlags -contains $word) { $skip = $true; continue }
      if ($word.StartsWith('-')) { continue }
      $next = if ($context) { "$context $word" } else { $word }
      if ($paths -contains $next) { $context = $next }
    }
    switch ($context) {
${directory.contexts.map((context) => `      ${psQuote(context.path)} { $choices = @(${context.choices.map(psQuote).join(',')}); break }`).join('\n')}
    }
  }
  $choices | Where-Object { $_.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
}

export function registerCompletionCommand(program: Command): void {
  const completion = program.command('completion')
    .description('Print a shell completion script for bash, zsh, fish, or powershell')
    .argument('<shell>', 'bash | zsh | fish | powershell (alias: pwsh)')
    .addHelpText('after', `
The command emits shell source, not JSON. Install with:
  bash       source <(switchbot completion bash)
  zsh        source <(switchbot completion zsh)
  fish       switchbot completion fish > ~/.config/fish/completions/switchbot.fish
  powershell switchbot completion powershell | Out-String | Invoke-Expression
`)
    .action((shell: string) => {
      if (isJsonMode()) {
        exitWithError({ code: 2, kind: 'usage', message: 'Shell completion emits source code; omit --json or --format json.' });
      }
      const directory = completionDirectory(program);
      switch (shell.toLowerCase()) {
        case 'bash': process.stdout.write(bashScript(directory)); return;
        case 'zsh': process.stdout.write(zshScript(directory)); return;
        case 'fish': process.stdout.write(fishScript(directory)); return;
        case 'powershell':
        case 'pwsh': process.stdout.write(powershellScript(directory)); return;
        default:
          completion.error(`error: unsupported shell "${shell}" (choose from: bash, zsh, fish, powershell)`,
            { exitCode: 2, code: 'switchbot.unsupportedShell' });
      }
    });
}
