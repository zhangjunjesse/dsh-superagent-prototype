// Run from the client department's workspace against the exact file delivered by development.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [htmlFile, expectedVersion, outputDirectory, driverModule, executablePath] = process.argv.slice(2);
assert.ok(htmlFile && expectedVersion && outputDirectory, 'Pass the delivered HTML file, its SHA-256, and the client output directory.');
const { chromium } = createRequire(import.meta.url)(driverModule ?? 'playwright-core');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const version = hash(await readFile(htmlFile));
assert.equal(version, expectedVersion, 'The page does not match the development handoff.');
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(pathToFileURL(resolve(htmlFile)).href);
  const expected = [{ id: 'A-017', name: '蓝色样品' }, { id: 'B-042', name: '绿色样品' }];
  const shown = await page.locator('tbody tr').evaluateAll(rows =>
    rows.map(row => ({ id: row.cells[0].textContent, name: row.cells[1].textContent })));
  assert.deepEqual(shown, expected, 'The page must show both known records.');
  await page.screenshot({ path: join(outputDirectory, 'verification.png'), fullPage: true });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出记录' }).click()]);
  assert.equal(download.suggestedFilename(), 'records.json');
  const path = join(outputDirectory, 'records.json');
  await download.saveAs(path);
  const bytes = await readFile(path), exported = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(exported, expected, 'The downloaded file must contain exactly the two displayed records, in order.');
  assert.equal(hash(await readFile(htmlFile)), version, 'The page changed during validation.');
  const evidence = { version, file: 'records.json', sha256: hash(bytes), browser: browser.version(), displayed: shown, downloaded: exported };
  await writeFile(join(outputDirectory, 'verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}
