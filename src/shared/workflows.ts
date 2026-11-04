import { z } from 'zod';

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (s) =>
        !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
        !/[\u202a-\u202e\u2066-\u2069]/.test(s),
    );
export const workflowSchema = z
  .object({
    id: z.string().uuid(),
    name: text(80).min(1),
    description: text(400),
    directory: text(1024)
      .min(1)
      .refine((s) => s.startsWith('/') || s === '~' || s.startsWith('~/')),
    steps: z
      .array(
        text(4096)
          .min(1)
          .refine((s) => !/[\r\n]/.test(s)),
      )
      .min(1)
      .max(32),
    variables: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
            type: z.enum(['text', 'integer']),
            label: text(80).min(1),
          })
          .strict(),
      )
      .max(16),
    followLast: z.boolean(),
    confirmBeforeRun: z.boolean().default(true),
    minutes: z.number().int().min(1).max(120),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (new Set(w.variables.map((v) => v.name)).size !== w.variables.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate variable names.' });
  });
export type Workflow = z.input<typeof workflowSchema>;
export type WorkflowPlan = {
  name: string;
  directory: string;
  commands: string[];
  scripts: string[];
  followLast: boolean;
  minutes: number;
  confirmBeforeRun?: boolean;
};
export type WorkflowUpdate = {
  following?: boolean;
  id: string;
  step: number;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  output?: string;
  message?: string;
};
export const workflowValuesSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    text(1024).refine((s) => !/[\r\n]/.test(s)),
  )
  .refine((v) => Object.keys(v).length <= 16);
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export function renderWorkflow(input: Workflow, inputValues: Record<string, string>): WorkflowPlan {
  const w = workflowSchema.parse(input);
  const values = workflowValuesSchema.parse(inputValues);
  const names = new Set(w.variables.map((v) => v.name));
  if (Object.keys(values).some((n) => !names.has(n)))
    throw new Error('Unexpected workflow variable.');
  for (const variable of w.variables) {
    const value = values[variable.name];
    if (
      !Object.hasOwn(values, variable.name) ||
      !value?.length ||
      (variable.type === 'integer' && !/^-?\d{1,15}$/.test(value))
    )
      throw new Error(`Enter a valid ${variable.type} value for ${variable.label}.`);
  }
  const substitute = (source: string, command: boolean) => {
    let quote = '';
    let escaped = false;
    let substitution = 0;
    let result = '';
    for (let i = 0; i < source.length; i++) {
      if (source.startsWith('{{', i)) {
        // Docker --format commonly uses quoted Go-template field expressions.
        // These are literal saved code, never a value-interpolation context.
        if (command && quote && source.startsWith('{{.', i)) {
          const end = source.indexOf('}}', i + 3);
          if (end < 0) throw new Error('Unclosed Docker format expression.');
          result += source.slice(i, end + 2);
          i = end + 1;
          continue;
        }
        const match = /^\{\{([a-z][a-z0-9_]{0,31})\}\}/.exec(source.slice(i));
        if (!match || !names.has(match[1]))
          throw new Error('Unknown or malformed variable placeholder.');
        if (
          command &&
          (quote ||
            escaped ||
            substitution ||
            (i > 0 && !/[\s;&|()<>]/.test(source[i - 1])) ||
            (i + match[0].length < source.length &&
              !/[\s;&|()<>]/.test(source[i + match[0].length])))
        )
          throw new Error(
            'Command placeholders must be whole unquoted arguments, outside substitutions.',
          );
        result += command ? shellQuote(values[match[1]]) : values[match[1]];
        i += match[0].length - 1;
        continue;
      }
      const ch = source[i];
      result += ch;
      if (!command) continue;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && quote !== "'") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '$' && source[i + 1] === '(') substitution++;
      if (ch === ')' && substitution) substitution--;
    }
    return result;
  };
  const directory = substitute(w.directory, false);
  // Variables cannot change a selected home path into an arbitrary shell expression.
  if (!directory.startsWith('/') && directory !== '~' && !directory.startsWith('~/'))
    throw new Error('Use an absolute or ~/ working directory.');
  const cd =
    directory === '~'
      ? '"$HOME"'
      : directory.startsWith('~/')
        ? `"$HOME"/${shellQuote(directory.slice(2))}`
        : shellQuote(directory);
  const commands = w.steps.map((step) => {
    if (step.includes('{{') && /\$\(|\$\{|`|<</.test(step))
      throw new Error(
        'Variable steps cannot contain command/arithmetic substitutions, parameter expansions, backticks or heredocs. Use a separate simple step.',
      );
    if (/^\s*cd(?:\s|$)/.test(step))
      throw new Error(
        'Put the working directory in its own field; standalone cd steps do not persist across shells.',
      );
    return substitute(step, true);
  });
  if (
    directory.length > 4096 ||
    commands.some((c) => Buffer.byteLength(c) > 8192) ||
    commands.reduce((n, c) => n + Buffer.byteLength(c), 0) > 24576
  )
    throw new Error(
      'Expanded workflow exceeds the preview safety limit (8 KiB per step, 24 KiB total).',
    );
  const scripts = commands.map((command) => `cd -- ${cd} && (\n${command}\n)`);
  if (scripts.reduce((n, s) => n + Buffer.byteLength(s), 0) > 32768)
    throw new Error(
      'Expanded executable preview exceeds 32 KiB. Shorten the working directory or commands.',
    );
  return {
    name: w.name,
    directory,
    commands,
    scripts,
    followLast: w.followLast,
    minutes: w.minutes,
    confirmBeforeRun: w.confirmBeforeRun,
  };
}
