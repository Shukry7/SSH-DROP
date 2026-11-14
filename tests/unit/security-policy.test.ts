import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateAudit } from '../../scripts/security-audit.mjs';
import { looksSensitive } from '../../scripts/check-secrets.mjs';

const url = 'https://github.com/advisories/GHSA-g3hv-75wg-m249';
const node = 'node_modules/glob/node_modules/minimatch';
const now = new Date('2026-11-02T00:00:00Z');
const policy = [
  {
    advisory: url,
    package: 'minimatch',
    versions: ['3.1.5'],
    expires: '2026-12-02',
    reason: 'Legacy implementation lacks the affected algorithm.',
  },
];
const lock = { packages: { [node]: { version: '3.1.5', dev: true } } };
const report = () => ({
  auditReportVersion: 2,
  metadata: { vulnerabilities: { total: 1, high: 0, critical: 0 } },
  vulnerabilities: {
    minimatch: {
      name: 'minimatch',
      severity: 'moderate',
      nodes: [node],
      via: [{ name: 'minimatch', severity: 'moderate', url }],
    },
  },
});

describe('dependency security policy', () => {
  it('accepts a complete clean audit and the exact reviewed development-only exception', () => {
    expect(
      evaluateAudit(
        { ...report(), metadata: { vulnerabilities: { total: 0 } }, vulnerabilities: {} },
        lock,
        [],
        now,
      ),
    ).toEqual({ findings: 0, acceptedNodes: 0 });
    expect(evaluateAudit(report(), lock, policy, now)).toEqual({ findings: 1, acceptedNodes: 1 });
  });
  it('rejects missing reports, service errors, incomplete results, and unreviewed advisories', () => {
    for (const value of [
      {},
      { ...report(), error: { code: 'ENETUNREACH' } },
      { ...report(), vulnerabilities: {} },
    ])
      expect(() => evaluateAudit(value, lock, policy, now)).toThrow();
    expect(() => evaluateAudit(report(), lock, [], now)).toThrow('Unreviewed');
  });
  it('rejects expiry, new versions, and production dependencies', () => {
    expect(() => evaluateAudit(report(), lock, policy, new Date('2026-12-02'))).toThrow('expired');
    expect(() =>
      evaluateAudit(report(), lock, [{ ...policy[0], expires: '2026-99-99' }], now),
    ).toThrow('expired');
    expect(() =>
      evaluateAudit(
        report(),
        { packages: { [node]: { version: '3.1.6', dev: true } } },
        policy,
        now,
      ),
    ).toThrow('version');
    expect(() =>
      evaluateAudit(report(), { packages: { [node]: { version: '3.1.5' } } }, policy, now),
    ).toThrow('production');
  });
  it('blocks high/critical findings even if an advisory is otherwise known', () => {
    for (const severity of ['high', 'critical'] as const) {
      const value = report();
      value.metadata.vulnerabilities[severity] = 1;
      expect(() => evaluateAudit(value, lock, policy, now)).toThrow('High or critical');
    }
  });
  it('does not allow unknown or cyclic advisory chains to hide behind reviewed findings', () => {
    const value = report();
    const cycle = { name: 'cycle', severity: 'moderate', nodes: [node], via: ['cycle'] };
    const cyclic = {
      ...value,
      metadata: { vulnerabilities: { total: 2 } },
      vulnerabilities: { ...value.vulnerabilities, cycle },
    };
    expect(() => evaluateAudit(cyclic, lock, policy, now)).toThrow('reviewed root');
    expect(() =>
      evaluateAudit(
        {
          ...cyclic,
          vulnerabilities: { ...value.vulnerabilities, cycle: { ...cycle, via: ['missing'] } },
        },
        lock,
        policy,
        now,
      ),
    ).toThrow('unreviewed');
  });
  it('checks the installed legacy API and absence of the advisory preprocessing functions', () => {
    const require = createRequire(import.meta.url);
    const packages = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages;
    const exceptions = JSON.parse(readFileSync('scripts/security-exceptions.json', 'utf8'));
    for (const [path, pkg] of Object.entries(packages) as [
      string,
      { version: string; dev?: boolean },
    ][]) {
      if (!path.endsWith('/minimatch')) continue;
      const matcher = require(resolve(path));
      if (pkg.version === '11.0.1') expect(matcher.minimatch('example.txt', '*.txt')).toBe(true);
      else {
        expect(exceptions[0].versions).toContain(pkg.version);
        expect(pkg.dev).toBe(true);
        expect(matcher('example.txt', '*.txt')).toBe(true);
        expect(matcher.Minimatch.prototype).not.toHaveProperty('firstPhasePreProcess');
        expect(matcher.Minimatch.prototype).not.toHaveProperty('secondPhasePreProcess');
      }
    }
  });
});

describe('tracked-file secret detection', () => {
  it.each([
    'profiles.json',
    'data/known-hosts.json',
    'workflows.json',
    'data/workflows.json',
    'test.sshdrop-backup',
    'data/test.sshdrop-backup',
    'idle-settings.json',
    'data/idle-settings.json',
    'backups/vault-key.json',
    'backups/recovery.json',
    'backups/recovery.enc',
    'transfer-recovery/transfer-queue.enc',
    'backups/12345678-1234-1234-1234-123456789abc.bak',
    'backups/12345678-1234-1234-1234-123456789abc.bak.enc',
    '.env',
    '.env.production',
    'keys/id_ed25519',
  ])('rejects user-data file %s', (file) => expect(looksSensitive(file, '{}')).toBe(true));
  it('detects private-key markers and common service tokens without printing contents', () => {
    for (const value of [
      '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
      'ghp_' + 'A'.repeat(36),
      'github_pat_' + 'A'.repeat(60),
      'AKIA' + 'A'.repeat(16),
    ])
      expect(looksSensitive('source.txt', value)).toBe(true);
    expect(looksSensitive('.env.example', 'PORT=22')).toBe(false);
    expect(looksSensitive('README.md', 'No credentials here.')).toBe(false);
  });
});
