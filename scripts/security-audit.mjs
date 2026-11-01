import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function evaluateAudit(report, lock, exceptions, now = new Date()) {
  if (
    report?.error ||
    report?.auditReportVersion !== 2 ||
    !report.metadata?.vulnerabilities ||
    !report.vulnerabilities
  )
    throw new Error('The advisory service did not return a valid audit report.');
  const metadata = report.metadata.vulnerabilities;
  const findings = Object.values(report.vulnerabilities);
  if (metadata.total !== findings.length) throw new Error('Incomplete vulnerability report.');
  if (metadata.high || metadata.critical)
    throw new Error('High or critical dependency findings must be resolved.');
  const accepted = new Set();
  const visit = (finding, seen = new Set()) => {
    if (
      !finding ||
      !['low', 'moderate'].includes(finding.severity) ||
      !finding.nodes?.length ||
      !finding.via?.length
    )
      throw new Error('An unreviewed dependency finding must be resolved.');
    for (const node of finding.nodes) {
      if (lock.packages?.[node]?.dev !== true)
        throw new Error(`A production dependency is affected: ${finding.name}`);
    }
    if (seen.has(finding.name)) return false;
    seen.add(finding.name);
    let hasRoot = false;
    for (const source of finding.via) {
      if (typeof source === 'string') {
        hasRoot = visit(report.vulnerabilities[source], seen) || hasRoot;
        continue;
      }
      const exception = exceptions.find(
        (entry) => entry.advisory === source.url && entry.package === source.name,
      );
      const expiry = new Date(`${exception?.expires}T00:00:00Z`);
      if (
        !exception ||
        source.severity !== 'moderate' ||
        !exception.reason ||
        !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires) ||
        !Number.isFinite(expiry.getTime()) ||
        expiry.toISOString().slice(0, 10) !== exception.expires ||
        now >= expiry
      )
        throw new Error(`Unreviewed or expired advisory: ${source.url}`);
      for (const node of finding.nodes) {
        const pkg = lock.packages[node];
        if (
          !node.endsWith(`/node_modules/${exception.package}`) &&
          node !== `node_modules/${exception.package}`
        )
          throw new Error('Advisory package does not match the lockfile.');
        if (!exception.versions.includes(pkg.version))
          throw new Error(`Unreviewed vulnerable version: ${finding.name}`);
        accepted.add(`${source.url} ${node} ${pkg.version}`);
        hasRoot = true;
      }
    }
    return hasRoot;
  };
  for (const finding of findings)
    if (!visit(finding)) throw new Error('An advisory chain has no reviewed root.');
  if (findings.length && !accepted.size) throw new Error('Audit has no reviewed advisory roots.');
  return { findings: findings.length, acceptedNodes: accepted.size };
}

async function main() {
  if (!process.env.npm_execpath) throw new Error('Run this check with npm run security:audit.');
  const scan = spawnSync(
    process.execPath,
    [process.env.npm_execpath, 'audit', '--json', '--fetch-retries=0', '--fetch-timeout=20000'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  if (scan.error || ![0, 1].includes(scan.status))
    throw new Error('Dependency audit could not complete. No clean result is assumed.');
  let report;
  try {
    report = JSON.parse(scan.stdout);
  } catch {
    throw new Error('Dependency audit returned an invalid response.');
  }
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/dependency-audit.json', JSON.stringify(report, null, 2) + '\n');
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const exceptions = JSON.parse(
    await readFile(new URL('./security-exceptions.json', import.meta.url), 'utf8'),
  );
  const result = evaluateAudit(report, lock, exceptions);
  console.log(
    `Dependency audit: ${result.findings} raw findings; ${result.acceptedNodes} exact development-only dependency paths covered by the expiring policy. No unreviewed findings.`,
  );
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
