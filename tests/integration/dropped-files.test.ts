import { link, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectDroppedFiles } from '../../src/main/core/dropped-files';
import { Session } from '../../src/main/core/session';
import type { TransferUpdate } from '../../src/shared/contracts';
import { sshFixture } from '../fixtures/ssh-server';

describe('native dropped upload jobs', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-drop-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('rejects directory drops, linked files, and portable name collisions', async () => {
    const first = join(directory, 'First.txt');
    const other = join(directory, 'other');
    await mkdir(other);
    await writeFile(first, 'selected bytes');
    await writeFile(join(other, 'first.txt'), 'other bytes');
    await expect(
      inspectDroppedFiles({ directory: '/', files: [first, join(other, 'first.txt')] }),
    ).rejects.toThrow('colliding names');
    await expect(inspectDroppedFiles({ directory: '/', files: [other] })).rejects.toThrow(
      'regular files',
    );
    await link(first, join(other, 'linked.txt'));
    await expect(inspectDroppedFiles({ directory: '/', files: [first] })).rejects.toThrow(
      'hard links',
    );
    await expect(
      inspectDroppedFiles({ directory: '/folder/../', files: [first] }),
    ).rejects.toThrow();
  });

  it('uploads reviewed bytes and refuses a changed source before opening a remote staging file', async () => {
    const fixture = await sshFixture();
    const updates: TransferUpdate[] = [];
    const session = new Session({ verify: async () => true }, (event) => {
      if (event.type === 'transfer') updates.push(event.transfer);
    });
    try {
      await session.connect({
        host: '127.0.0.1',
        port: fixture.port,
        username: 'tester',
        password: 'test-password',
      });
      const first = join(directory, 'reviewed.txt');
      const second = join(directory, 'changed.txt');
      await writeFile(first, 'first bytes');
      await writeFile(second, 'second bytes');
      const { jobs } = await inspectDroppedFiles({ directory: '/folder', files: [first, second] });
      await writeFile(second, 'new contents after confirmation');
      session.enqueue(jobs);
      await expect.poll(() => updates.at(-1)?.status, { timeout: 10000 }).toBe('failed');
      expect(updates.at(-1)?.error).toContain('changed after review');
      expect(fixture.files.get('/folder/reviewed.txt')?.toString()).toBe('first bytes');
      expect(fixture.files.has('/folder/changed.txt')).toBe(false);
      expect(fixture.openedFiles.filter((path) => path.endsWith('.part'))).toHaveLength(2);
    } finally {
      session.disconnect();
      await fixture.close();
    }
  });
});
