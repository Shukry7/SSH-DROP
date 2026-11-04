import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  renderWorkflow,
  shellQuote,
  workflowSchema,
  type Workflow,
} from '../../src/shared/workflows';
const w = (): Workflow => ({
  id: randomUUID(),
  name: 'Logs',
  description: '',
  directory: '~/sample-project',
  steps: ['docker logs --tail {{lines}} demo-service'],
  variables: [{ name: 'lines', type: 'integer', label: 'Lines' }],
  minutes: 30,
  followLast: false,
});
describe('workflow templates and argument boundaries', () => {
  it('defaults missing confirmation preferences to on and rejects non-boolean opt-outs', () => {
    expect(workflowSchema.parse(w()).confirmBeforeRun).toBe(true);
    expect(renderWorkflow(w(), { lines: '15' }).confirmBeforeRun).toBe(true);
    expect(
      renderWorkflow({ ...w(), confirmBeforeRun: false }, { lines: '15' }).confirmBeforeRun,
    ).toBe(false);
    expect(workflowSchema.safeParse({ ...w(), confirmBeforeRun: 'false' }).success).toBe(false);
  });
  it('preserves quoted Docker field-format expressions instead of treating them as variables', () => {
    const step = "docker inspect --format '{{.State.Status}}' {{lines}}";
    expect(renderWorkflow({ ...w(), steps: [step] }, { lines: '15' }).commands[0]).toBe(
      "docker inspect --format '{{.State.Status}}' '15'",
    );
  });
  it('bounds expanded arguments and the complete executable preview', () => {
    const base = { ...w(), variables: [{ name: 'lines', type: 'text' as const, label: 'Text' }] };
    const values = { lines: 'x'.repeat(1024) };
    expect(() =>
      renderWorkflow({ ...base, steps: ['echo ' + Array(9).fill('{{lines}}').join(' ')] }, values),
    ).toThrow('safety limit');
    expect(() =>
      renderWorkflow({ ...base, steps: Array(7).fill('echo ' + 'x'.repeat(4000)) }, values),
    ).toThrow('safety limit');
    expect(() =>
      renderWorkflow(
        {
          ...base,
          directory: '/{{lines}}/{{lines}}/{{lines}}',
          steps: Array(11).fill('echo done'),
        },
        values,
      ),
    ).toThrow('32 KiB');
  });
  it.each(['echo ${value:- {{lines}} }', 'echo `printf hi` {{lines}}', 'cat << {{lines}}'])(
    'refuses shell expansion context %s',
    (step) => {
      expect(() => renderWorkflow({ ...w(), steps: [step] }, { lines: '15' })).toThrow();
    },
  );
  it('renders a home directory and typed values into the exact executable preview', () => {
    const plan = renderWorkflow(w(), { lines: '200' });
    expect(plan.commands[0]).toBe("docker logs --tail '200' demo-service");
    expect(plan.scripts[0]).toContain('cd -- "$HOME"/\'sample-project\' && (');
  });
  it('quotes hostile strings as one literal argument and quotes directory values independently', () => {
    const value = "15'; $(touch /tmp/NEVER); #";
    const data = {
      ...w(),
      directory: '/srv/{{lines}}',
      variables: [{ name: 'lines', type: 'text' as const, label: 'Search' }],
    };
    const plan = renderWorkflow(data, { lines: value });
    expect(plan.commands[0]).toBe(`docker logs --tail ${shellQuote(value)} demo-service`);
    expect(plan.scripts[0]).toContain(shellQuote('/srv/' + value));
  });
  it.each(['1; reboot', '1.5', '1e3', '', '9999999999999999'])(
    'rejects invalid integer %s',
    (lines) => {
      expect(() => renderWorkflow(w(), { lines })).toThrow();
    },
  );
  it.each([
    "echo '{{lines}}'",
    'echo "{{lines}}"',
    'echo prefix{{lines}}',
    'echo $(echo {{lines}})',
    'echo \\{{lines}}',
    'echo {{missing}}',
    'echo {{broken',
    'cd ~/maps',
  ])('rejects ambiguous template %s', (step) => {
    expect(() => renderWorkflow({ ...w(), steps: [step] }, { lines: '15' })).toThrow();
  });
  it('rejects unknown/missing variables and control characters', () => {
    expect(() => renderWorkflow(w(), {})).toThrow();
    expect(() => renderWorkflow(w(), { lines: '1', extra: 'x' })).toThrow();
    expect(() =>
      renderWorkflow(
        { ...w(), variables: [{ name: 'lines', type: 'text', label: 'x' }] },
        { lines: 'x\nreboot' },
      ),
    ).toThrow();
  });
  it('rejects duplicate definitions, unsafe directories and excessive steps', () => {
    expect(
      workflowSchema.safeParse({ ...w(), variables: [...w().variables, ...w().variables] }).success,
    ).toBe(false);
    expect(workflowSchema.safeParse({ ...w(), directory: 'relative' }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...w(), steps: [] }).success).toBe(false);
  });
});
