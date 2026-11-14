import { useWorkspace } from './WorkspaceContext';
import { useEffect, useId, useState } from 'react';
import type { Result } from '../../shared/contracts';
import type { Workflow, WorkflowPlan, WorkflowUpdate } from '../../shared/workflows';
const unwrap = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const fresh = (): Workflow => ({
  id: crypto.randomUUID(),
  name: 'Print a message',
  description: 'Print an entered message without changing files or the interactive terminal.',
  directory: '~',
  steps: ["printf '%s\\n' {{message}}"],
  variables: [{ name: 'message', type: 'text', label: 'Message' }],
  followLast: false,
  confirmBeforeRun: true,
  minutes: 30,
});
const exampleWorkflow = (): Workflow => ({
  ...fresh(),
  name: 'System check',
  description:
    'A generic, non-destructive example: show the working directory, operating system and an entered message.',
  steps: ['pwd', 'uname -s', "printf '%s\\n' {{message}}"],
});
export function Workflows({ connected }: { connected: boolean }) {
  const { api } = useWorkspace();
  const localId = useId();
  const [items, setItems] = useState<Workflow[]>([]);
  const [selected, setSelected] = useState('');
  const [editor, setEditor] = useState<Workflow>();
  const [steps, setSteps] = useState('');
  const [variables, setVariables] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{
    token: string;
    server: string;
    plan: WorkflowPlan;
    workflowId: string;
  }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<WorkflowUpdate>();
  const [lastRun, setLastRun] = useState<{ workflowId: string; runId: string }>();
  const [rerunReview, setRerunReview] = useState(false);
  const [output, setOutput] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [importReview, setImportReview] = useState(false);
  const groups = [
    ...new Set(items.map((item) => item.group).filter((value): value is string => !!value)),
  ].sort();
  const visible = items.filter(
    (item) =>
      (!group || item.group === group) &&
      `${item.name} ${item.description} ${item.group ?? ''}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  const refresh = async () => setItems(unwrap(await api.workflows()));
  useEffect(() => {
    let alive = true;
    void api
      .workflows()
      .then((result) => {
        if (alive) setItems(unwrap(result));
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'workflow-warning') setNotice(event.message);
      if (event.type === 'workflow-reset') {
        setPreview(undefined);
        setValues({});
        setRun(undefined);
        setLastRun(undefined);
        setRerunReview(false);
        setOutput('');
      }
      if (event.type === 'workflow') {
        setRun(event.update);
        if (event.update.output) setOutput((old) => (old + event.update.output).slice(-131072));
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  };
  const edit = (w: Workflow, imported = false) => {
    setEditor(w);
    setSteps(w.steps.join('\n'));
    setVariables(w.variables.map((v) => `${v.name}:${v.type}:${v.label}`).join('\n'));
    setPreview(undefined);
    setImportReview(imported);
  };
  const current = items.find((w) => w.id === selected);
  const running = run?.status === 'running';
  const start = async (value: NonNullable<typeof preview>) => {
    setPreview(undefined);
    setOutput('');
    if (unwrap(await api.runWorkflow(value.token))) {
      setLastRun({ workflowId: value.workflowId, runId: value.token });
      setRerunReview(false);
    }
  };
  return (
    <section className="panel workflows" aria-label="Saved workflows">
      <div className="panel-heading">
        <h3>Commands & workflows</h3>
        <span className="small-label">SAVED ON THIS COMPUTER · ALL SERVERS</span>
      </div>
      <div className="workflow-content">
        {notice && (
          <div role="status">
            <p>{notice}</p>
            <button
              className="secondary compact"
              aria-label="Dismiss workflow warning"
              onClick={() => setNotice('')}
            >
              Dismiss notice
            </button>
          </div>
        )}
        <p>
          Run reviewed commands in separate remote POSIX shells. Commands can delete data or stop
          services. Enter working directory separately; shell state does not carry between steps.
          Definitions are saved unencrypted locally; never store secrets.
        </p>
        <div className="toolbar">
          <label>
            Search workflows
            <input
              type="search"
              value={search}
              maxLength={400}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelected('');
                setValues({});
                setPreview(undefined);
                setRerunReview(false);
              }}
            />
          </label>
          <label>
            Workflow group
            <select
              aria-label="Workflow group"
              value={group}
              onChange={(event) => {
                setGroup(event.target.value);
                setSelected('');
                setValues({});
                setPreview(undefined);
                setRerunReview(false);
              }}
            >
              <option value="">All groups</option>
              {groups.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Saved workflow
            <select
              aria-label="Saved workflow"
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setValues({});
                setPreview(undefined);
                setRerunReview(false);
              }}
            >
              <option value="">Choose a workflow</option>
              {visible.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary compact" disabled={busy} onClick={() => edit(fresh())}>
            New workflow
          </button>
          <button
            className="secondary compact"
            disabled={busy}
            onClick={() => edit(exampleWorkflow())}
          >
            Example workflow
          </button>
          <button
            className="secondary compact"
            disabled={!current || busy}
            onClick={() => edit(current!)}
          >
            Edit workflow
          </button>
          <button
            className="secondary compact"
            disabled={!current || busy || !!editor}
            onClick={() =>
              edit({
                ...current!,
                id: crypto.randomUUID(),
                name: `${current!.name.slice(0, 73)} (copy)`,
                confirmBeforeRun: true,
              })
            }
          >
            Duplicate workflow
          </button>
          <button
            className="secondary compact"
            disabled={busy || !!editor}
            onClick={() =>
              void perform(async () => {
                const imported = unwrap(await api.importWorkflow());
                if (imported) edit(imported, true);
              })
            }
          >
            Import workflow
          </button>
          <button
            className="secondary compact"
            disabled={!current || busy}
            onClick={() =>
              void perform(async () => {
                unwrap(await api.exportWorkflow(current!.id));
              })
            }
          >
            Export workflow
          </button>
          <button
            className="text-button danger-button"
            disabled={!current || busy}
            onClick={() =>
              void perform(async () => {
                unwrap(await api.deleteWorkflow(selected));
                setPreview(undefined);
                await refresh();
                setSearch('');
                setGroup('');
              })
            }
          >
            Delete workflow
          </button>
        </div>
        {editor && (
          <form
            className="workflow-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const lines = steps
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean);
                const defs = variables
                  .split('\n')
                  .filter((s) => s.trim())
                  .map((s) => {
                    const [name, type, ...label] = s.split(':');
                    return {
                      name: name.trim(),
                      type: type?.trim(),
                      label: label.join(':').trim() || name.trim(),
                    };
                  });
                const saved = unwrap(
                  await api.saveWorkflow({
                    ...editor,
                    steps: lines,
                    variables: defs as Workflow['variables'],
                  }),
                );
                await refresh();
                setSearch('');
                setGroup('');
                setSelected(saved.id);
                setValues({});
                setEditor(undefined);
                setImportReview(false);
                setPreview(undefined);
              });
            }}
          >
            {importReview && (
              <p role="status">
                Review every imported command and its working directory before saving. Commands can
                delete data or affect services. Run confirmation starts enabled.
              </p>
            )}
            <label>
              Name
              <input
                aria-label="Workflow name"
                value={editor.name}
                maxLength={80}
                required
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </label>
            <label>
              Description / warnings
              <input
                aria-label="Workflow description"
                value={editor.description}
                maxLength={400}
                onChange={(e) => setEditor({ ...editor, description: e.target.value })}
              />
            </label>
            <label>
              Group
              <input
                aria-label="Workflow group name"
                maxLength={60}
                value={editor.group ?? ''}
                onChange={(event) => setEditor({ ...editor, group: event.target.value })}
              />
            </label>
            <label>
              Working directory
              <input
                aria-label="Workflow working directory"
                value={editor.directory}
                required
                onChange={(e) => setEditor({ ...editor, directory: e.target.value })}
              />
            </label>
            <label>
              Steps — one complete command per line, maximum 32
              <textarea
                aria-label="Workflow steps"
                rows={7}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
              />
            </label>
            <label>
              Variables — name:text:Label or name:integer:Label
              <textarea
                aria-label="Workflow variables"
                rows={3}
                value={variables}
                onChange={(e) => setVariables(e.target.value)}
              />
            </label>
            <p>
              Use {'{{name}}'} as a whole unquoted command argument, e.g. --user-id {'{{user_id}}'}.
              Working-directory placeholders are also supported. Entered values are not saved.
            </p>
            <label>
              Maximum runtime per command (minutes, 1–120)
              <input
                aria-label="Workflow timeout"
                aria-describedby={localId}
                type="number"
                min={1}
                max={120}
                value={editor.minutes}
                onChange={(e) => setEditor({ ...editor, minutes: Number(e.target.value) })}
              />
            </label>
            <p id={localId}>
              Commands start immediately and continue to the next step as soon as they succeed. This
              is a time limit, not a delay. If it expires, later steps do not run; remote work may
              still continue. Follow-logs mode uses a separate 12-hour limit for the last step.
            </p>
            <label className="workflow-check">
              <input
                type="checkbox"
                checked={editor.confirmBeforeRun !== false}
                onChange={(e) => setEditor({ ...editor, confirmBeforeRun: e.target.checked })}
              />
              Ask for confirmation before running (recommended)
            </label>
            <p>
              Turning this off skips the run confirmation dialog on every server. Run again starts
              immediately when no variables are required. Repeated commands may duplicate changes;
              inspect uncertain results before running again.
            </p>
            <label className="workflow-check">
              <input
                type="checkbox"
                checked={editor.followLast}
                onChange={(e) => setEditor({ ...editor, followLast: e.target.checked })}
              />
              Last step follows logs (up to 12 hours; 2 MiB output limit)
            </label>
            <div className="toolbar">
              <button className="primary" type="submit" disabled={busy}>
                Save workflow
              </button>
              <button className="secondary" type="button" onClick={() => setEditor(undefined)}>
                Cancel edit
              </button>
            </div>
          </form>
        )}
        {current && (
          <div>
            <p>{current.description}</p>
            {current.confirmBeforeRun === false && (
              <p role="status">Run confirmation is off for this workflow on all servers.</p>
            )}
            {rerunReview && (
              <p role="status">
                Run again starts the entire latest saved workflow from step 1. Enter variables again
                and review the server and commands before submitting. Inspect previous results
                first; repeating commands can duplicate changes or affect services.
              </p>
            )}
            {current.variables.map((v) => (
              <label key={v.name}>
                {v.label}
                <input
                  aria-label={`Variable ${v.name}`}
                  type={v.type === 'integer' ? 'number' : 'text'}
                  maxLength={1024}
                  value={values[v.name] ?? ''}
                  onChange={(e) => {
                    setValues({ ...values, [v.name]: e.target.value });
                    setPreview(undefined);
                  }}
                />
              </label>
            ))}
            <button
              className="secondary"
              disabled={!connected || busy || running || !!editor}
              onClick={() =>
                void perform(async () => {
                  setPreview({
                    ...unwrap(await api.previewWorkflow({ id: current.id, values })),
                    workflowId: current.id,
                  });
                })
              }
            >
              Preview workflow
            </button>
          </div>
        )}
        {preview && (
          <div className="workflow-preview">
            <h4>Review: {preview.plan.name}</h4>
            <p>
              Server: <strong>{preview.server}</strong> · Directory: {preview.plan.directory}
            </p>
            <p>
              Each step runs in its own shell. Later steps stop on failure. No rollback or automatic
              replay. Stop/disconnect may leave remote work running.
            </p>
            <p>
              Maximum runtime: {preview.plan.minutes} minutes per command.
              {preview.plan.followLast ? ' The last step follows logs for up to 12 hours.' : ''}
            </p>
            {preview.plan.scripts.map((s, i) => (
              <div key={i}>
                <strong>
                  Step {i + 1}
                  {preview.plan.followLast && i === preview.plan.scripts.length - 1
                    ? ' — following logs'
                    : ''}
                </strong>
                <pre>{s}</pre>
              </div>
            ))}
            <button
              className="primary"
              disabled={busy || running || !connected}
              onClick={() =>
                void perform(async () => {
                  await start(preview);
                })
              }
            >
              {preview.plan.confirmBeforeRun === false
                ? 'Run workflow'
                : 'Confirm and run workflow'}
            </button>
            <button className="secondary" onClick={() => setPreview(undefined)}>
              Cancel preview
            </button>
          </div>
        )}
        {run && (
          <div role="group" aria-label="Workflow results">
            <div className="toolbar">
              <strong>
                Step {run.step + 1}:{' '}
                {run.status === 'running' && run.following ? 'Following logs' : run.status}
              </strong>
              {running && (
                <button
                  className="secondary"
                  onClick={() =>
                    void perform(async () => {
                      unwrap(await api.stopWorkflow(run.id));
                    })
                  }
                >
                  Stop workflow / following logs
                </button>
              )}
              {!running && lastRun?.runId === run.id && (
                <button
                  className="secondary"
                  disabled={!connected || busy || !!editor}
                  onClick={() =>
                    void perform(async () => {
                      setPreview(undefined);
                      const latest = unwrap(await api.workflows());
                      setItems(latest);
                      const workflow = latest.find((w) => w.id === lastRun.workflowId);
                      if (!workflow)
                        throw new Error(
                          'This workflow was deleted. Create or select a saved workflow.',
                        );
                      setSelected(workflow.id);
                      setValues({});
                      setRerunReview(true);
                      if (!workflow.variables.length) {
                        const next = {
                          ...unwrap(await api.previewWorkflow({ id: workflow.id, values: {} })),
                          workflowId: workflow.id,
                        };
                        if (next.plan.confirmBeforeRun === false) await start(next);
                        else setPreview(next);
                      }
                    })
                  }
                >
                  Run again
                </button>
              )}
            </div>
            {run.message && <p role="status">{run.message}</p>}
            <pre className="workflow-output" aria-label="Workflow output">
              {output || 'Waiting for output…'}
            </pre>
            <p>
              Showing the latest 128K characters; output is not saved. Remote programs may log
              command arguments. Stop cannot undo completed steps.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
