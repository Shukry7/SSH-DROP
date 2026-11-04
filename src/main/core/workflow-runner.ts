import { StringDecoder } from 'node:string_decoder';
import type { ClientChannel } from 'ssh2';
import type { WorkflowPlan, WorkflowUpdate } from '../../shared/workflows';
export const workflowLimits = { output: 2 * 1024 * 1024, open: 30000, follow: 12 * 60 * 60 * 1000 };
export async function runWorkflow(
  plan: WorkflowPlan,
  id: string,
  open: (script: string, cb: (error: Error | undefined, channel: ClientChannel) => void) => void,
  signal: AbortSignal,
  current: () => boolean,
  emit: (update: WorkflowUpdate) => void,
): Promise<void> {
  let total = 0;
  for (let step = 0; step < plan.scripts.length; step++) {
    if (signal.aborted || !current()) return;
    const following = plan.followLast && step === plan.scripts.length - 1;
    emit({ id, step, status: 'running', following });
    try {
      await new Promise<void>((resolve, reject) => {
        let channel: ClientChannel | undefined;
        let done = false;
        let exit: number | undefined;
        let pending = '';
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        let execution: ReturnType<typeof setTimeout> | undefined;
        const out = new StringDecoder('utf8');
        const err = new StringDecoder('utf8');
        const flush = () => {
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = undefined;
          if (pending && current()) {
            emit({ id, step, status: 'running', output: pending, following });
            pending = '';
          }
        };
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (execution) clearTimeout(execution);
          signal.removeEventListener('abort', abort);
          flush();
          if (error) {
            try {
              channel?.signal('INT');
              channel?.close();
            } catch {
              /* The remote result remains uncertain. */
            }
            reject(error);
          } else resolve();
        };
        const abort = () =>
          finish(
            new Error(
              'Stopped or disconnected. Remote work may still be running; inspect before retrying.',
            ),
          );
        const timer = setTimeout(
          () =>
            finish(
              new Error('Workflow timed out; remote work may continue. Inspect before retrying.'),
            ),
          workflowLimits.open,
        );
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        const data = (chunk: Buffer, decoder: StringDecoder) => {
          if (done) return;
          total += chunk.length;
          if (total > workflowLimits.output) {
            finish(
              new Error(
                'Output limit reached (2 MiB). Remote work may continue; inspect before retrying.',
              ),
            );
            return;
          }
          pending += decoder.write(chunk);
          if (pending.length >= 32768) flush();
          else if (!flushTimer) flushTimer = setTimeout(flush, 40);
        };
        try {
          open(plan.scripts[step], (error, stream) => {
            if (done) {
              stream?.close();
              return;
            }
            if (error) {
              finish(error);
              return;
            }
            channel = stream;
            if (!current()) {
              abort();
              return;
            }
            clearTimeout(timer);
            // Keep a single bounded timer for the active step, including follow mode.
            execution = setTimeout(
              () =>
                finish(
                  new Error('Step timed out; remote work may continue. Inspect before retrying.'),
                ),
              plan.followLast && step === plan.scripts.length - 1
                ? workflowLimits.follow
                : plan.minutes * 60000,
            );
            stream.once('close', () => {
              clearTimeout(execution);
              if (!done) {
                pending += out.end() + err.end();
                finish(
                  exit === 0
                    ? undefined
                    : new Error(
                        exit === undefined
                          ? 'Connection closed without an exit status. Outcome is uncertain.'
                          : `Step ${step + 1} failed (exit ${exit}); remaining steps were not run.`,
                      ),
                );
              }
            });
            stream.once('exit', (code: number) => {
              exit = code;
            });
            stream.once('error', () => {
              clearTimeout(execution);
              finish(new Error('Command channel failed. Remote work may continue.'));
            });
            stream.stderr.once('error', () =>
              finish(new Error('Command error stream failed. Remote work may continue.')),
            );
            stream.on('data', (chunk: Buffer) => data(chunk, out));
            stream.stderr.on('data', (chunk: Buffer) => data(chunk, err));
          });
        } catch {
          finish(new Error('Could not start the remote command.'));
        }
      });
    } catch (error) {
      if (current())
        emit({
          id,
          step,
          status: signal.aborted ? 'stopped' : 'failed',
          message: error instanceof Error ? error.message : 'Workflow failed.',
        });
      return;
    }
  }
  if (current() && !signal.aborted)
    emit({ id, step: plan.scripts.length - 1, status: 'completed' });
}
