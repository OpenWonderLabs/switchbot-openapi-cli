import type { Command, Option, Argument } from 'commander';
import { IDENTITY } from '../commands/identity.js';

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
  /** Root-only — present only when commandToJson() is called with {includeIdentity:true}. */
  product?: string;
  domain?: string;
  vendor?: string;
  apiVersion?: string;
  apiDocs?: string;
  productCategories?: readonly string[];
  arguments: ArgJson[];
  options: OptionJson[];
  subcommands: SubcommandJson[];
}

export interface CommandToJsonOptions {
  /** Inject product identity fields at top level. Intended for the root program only. */
  includeIdentity?: boolean;
}

export function commandToJson(cmd: Command, opts: CommandToJsonOptions = {}): CommandJson {
  const args: ArgJson[] = (cmd.registeredArguments as Argument[]).map((a) => ({
    name: a.name(),
    required: a.required,
    variadic: a.variadic,
    description: a.description ?? '',
  }));

  const options: OptionJson[] = (cmd.options as Option[])
    .filter((o) => o.long !== '--help' && o.long !== '--version')
    .map((o) => {
      const entry: OptionJson = { flags: o.flags, description: o.description ?? '' };
      if (o.defaultValue !== undefined) entry.defaultValue = o.defaultValue;
      if (o.argChoices && o.argChoices.length > 0) entry.choices = o.argChoices;
      return entry;
    });

  const subcommands: SubcommandJson[] = cmd.commands
    .filter((c) => !c.name().startsWith('_'))
    .map((c) => ({ name: c.name(), description: c.description() }));

  const out: CommandJson = {
    name: cmd.name(),
    description: cmd.description(),
    arguments: args,
    options,
    subcommands,
  };

  if (opts.includeIdentity) {
    out.product = IDENTITY.product;
    out.domain = IDENTITY.domain;
    out.vendor = IDENTITY.vendor;
    out.apiVersion = IDENTITY.apiVersion;
    out.apiDocs = IDENTITY.apiDocs;
    out.productCategories = IDENTITY.productCategories;
  }

  return out;
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
