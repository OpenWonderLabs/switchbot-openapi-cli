import type { Command, Option, Argument } from 'commander';

interface ArgJson {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
}

interface OptionJson {
  flags: string;
  description: string;
  defaultValue?: unknown;
  choices?: string[];
}

interface SubcommandJson {
  name: string;
  description: string;
}

export interface CommandJson {
  name: string;
  description: string;
  arguments: ArgJson[];
  options: OptionJson[];
  subcommands: SubcommandJson[];
}

export function commandToJson(cmd: Command): CommandJson {
  const args: ArgJson[] = (cmd.registeredArguments as Argument[]).map((a) => ({
    name: a.name(),
    required: a.required,
    variadic: a.variadic,
    description: a.description ?? '',
  }));

  const opts: OptionJson[] = (cmd.options as Option[])
    .filter((o) => o.long !== '--help' && o.long !== '--version')
    .map((o) => {
      const entry: OptionJson = { flags: o.flags, description: o.description ?? '' };
      if (o.defaultValue !== undefined) entry.defaultValue = o.defaultValue;
      if (o.argChoices && o.argChoices.length > 0) entry.choices = o.argChoices;
      return entry;
    });

  const subs: SubcommandJson[] = cmd.commands
    .filter((c) => !c.name().startsWith('_'))
    .map((c) => ({ name: c.name(), description: c.description() }));

  return {
    name: cmd.name(),
    description: cmd.description(),
    arguments: args,
    options: opts,
    subcommands: subs,
  };
}

/** Walk argv tokens (skipping flags) to find the deepest matching subcommand. */
export function resolveTargetCommand(root: Command, argv: string[]): Command {
  let cmd = root;
  for (const token of argv) {
    if (token.startsWith('-')) continue;
    const sub = cmd.commands.find(
      (c) => c.name() === token || (c.aliases() as string[]).includes(token)
    );
    if (sub) {
      cmd = sub;
    } else {
      break;
    }
  }
  return cmd;
}
