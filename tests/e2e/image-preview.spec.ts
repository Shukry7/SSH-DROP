import { test, expect, _electron as electron } from '@playwright/test';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';

for (const stalled of [false, true]) {
  test(
    stalled
      ? 'image preview loading can be cancelled without showing late pixels'
      : 'image preview is read-only, zooms, reports errors and clears on disconnect',
    async () => {
      test.setTimeout(60000);
      const directory = await mkdtemp(join(tmpdir(), 'sshdrop-image-ui-'));
      const fixture = await sshFixture({ stall: stalled ? ['READ'] : [] });
      const source = await sharp({
        create: { width: 320, height: 160, channels: 4, background: '#268caa88' },
      })
        .png()
        .toBuffer();
      fixture.files.set('/sample.png', source);
      fixture.files.set('/broken.png', Buffer.from('<svg><script>invalid</script></svg>'));
      fixture.files.set('/vector.svg', Buffer.from('<svg/>'));
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      delete env.ELECTRON_RUN_AS_NODE;
      env.SSHDROP_USER_DATA_DIR = directory;
      const application = await electron.launch({ args: ['.'], env, chromiumSandbox: true });
      try {
        await application.evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
        });
        const page = await application.firstWindow();
        await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
        await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
        await page.getByLabel('Username', { exact: true }).fill('tester');
        await page.getByLabel('Password', { exact: true }).fill('test-password');
        await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
        const row = (name: string) =>
          page
            .getByRole('row')
            .filter({ has: page.getByRole('checkbox', { name: `Select ${name}`, exact: true }) });
        await expect(row('vector.svg').getByRole('button', { name: 'Preview image' })).toHaveCount(
          0,
        );
        const invalid = await page.evaluate(() =>
          window.sshdrop.openImage({
            directory: '/',
            name: '../secret.png',
            requestId: crypto.randomUUID(),
          }),
        );
        expect(invalid.ok).toBe(false);
        await row('sample.png').getByRole('button', { name: 'Preview image' }).click();
        const preview = page.getByRole('dialog', { name: 'Image preview' });
        if (stalled) {
          await expect(preview.getByRole('status')).toHaveText('Loading image…');
          await expect.poll(() => fixture.openedFiles.includes('/sample.png')).toBe(true);
          await preview.getByRole('button', { name: 'Cancel preview' }).click();
          await expect(preview).toHaveCount(0);
          await expect(page.getByRole('img', { name: 'Preview of sample.png' })).toHaveCount(0);
          expect(fixture.files.get('/sample.png')).toEqual(source);
          return;
        }
        const image = preview.getByRole('img', { name: 'Preview of sample.png' });
        await expect(image).toBeVisible();
        await expect(preview).toContainText('320 × 160 pixels');
        expect(
          await image.evaluate((element: HTMLImageElement) => ({
            width: element.naturalWidth,
            height: element.naturalHeight,
            safe: element.src.startsWith('data:image/png;base64,'),
          })),
        ).toEqual({ width: 320, height: 160, safe: true });
        await preview.getByRole('button', { name: 'Actual size' }).click();
        await expect(image).toHaveCSS('width', '320px');
        await preview.getByRole('button', { name: 'Zoom in' }).click();
        await expect(image).toHaveCSS('width', '640px');
        await preview.getByRole('button', { name: 'Zoom out' }).click();
        await expect(image).toHaveCSS('width', '320px');
        await preview.getByRole('button', { name: 'Fit to window' }).click();
        await page.screenshot({ path: 'artifacts/image-preview.png' });
        await preview.press('Escape');
        await expect(preview).toHaveCount(0);
        expect(fixture.files.get('/sample.png')).toEqual(source);
        await row('broken.png').getByRole('button', { name: 'Preview image' }).click();
        await expect(preview.getByRole('alert')).toContainText('Only PNG');
        await expect(preview.getByRole('img')).toHaveCount(0);
        await preview.getByRole('button', { name: 'Close preview' }).click();
        await row('sample.png').getByRole('button', { name: 'Preview image' }).click();
        await expect(image).toBeVisible();
        fixture.drop();
        await expect(preview).toHaveCount(0);
        await expect(page.getByRole('img', { name: 'Preview of sample.png' })).toHaveCount(0);
      } finally {
        await application.close();
        await fixture.close();
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );
}
