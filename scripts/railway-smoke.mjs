import { chromium } from 'playwright-core';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const profile = await mkdtemp(join(tmpdir(), 'handfree-railway-smoke-'));
const artifactDir = resolve('output/playwright');
await mkdir(artifactDir, { recursive: true });
const extension = resolve('dist');
const browser = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.HANDFREE_CHROME || 'C:/Users/rohit/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});

const checks = [];
const errors = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
browser.on('page', (page) => {
  page.on('pageerror', (error) => errors.push(`pageerror: ${String(error)}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
});

try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await browser.newPage();
  await page.addInitScript(() => {
    class MockSpeechRecognition {
      static instances = [];
      continuous = false;
      interimResults = false;
      lang = 'en-US';
      onstart = null;
      onresult = null;
      onend = null;
      onerror = null;
      constructor() { MockSpeechRecognition.instances.push(this); }
      start() { this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
      emit(text) { this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); }
    }
    window.SpeechRecognition = MockSpeechRecognition;
    window.__handfreeEmitSpeech = (text) => MockSpeechRecognition.instances.at(-1)?.emit(text);
    window.SpeechSynthesisUtterance = class {
      rate = 1;
      volume = 1;
      onstart = null;
      onend = null;
      onerror = null;
      constructor(text) { this.text = text; }
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      cancel() {},
      speak(utterance) {
        window.__handfreeSpoken.push(utterance.text);
        utterance.onstart?.();
        setTimeout(() => utterance.onend?.(), 20);
      }
    } });
    window.__handfreeSpoken = [];
  });
  await page.goto(`chrome-extension://${extensionId}/railway.html`);
  await page.getByRole('heading', { name: 'Book a journey at your own pace.' }).waitFor();
  check('Railway Booking Demo loads in the extension', (await page.title()).includes('Railway Booking Demo'));
  check('local-only simulation warning is visible', (await page.getByText('SIMULATED · LOCAL ONLY').count()) === 1 && (await page.getByText(/No real ticket, payment/).count()) >= 1);
  check('semantic route controls are present', await page.locator('#railway-from').count() === 1 && await page.locator('#railway-to').count() === 1 && await page.locator('#railway-date').count() === 1);
  check('TouchView and Blind Mode controls are visible', await page.locator('#railway-touchview-toggle').count() === 1 && await page.getByRole('button', { name: 'Blind Mode' }).count() === 1);
  await page.locator('#railway-touchview-toggle').click();
  check('TouchView toggles on without redirecting the Railway page', await page.locator('#railway-touchview-toggle').getAttribute('aria-checked') === 'true' && new URL(page.url()).pathname.endsWith('/railway.html'));
  await page.locator('#railway-touchview-toggle').click();
  check('TouchView toggles back off cleanly', await page.locator('#railway-touchview-toggle').getAttribute('aria-checked') === 'false');

  await page.locator('#railway-search').click();
  await page.getByRole('heading', { name: 'Available demo trains' }).waitFor();
  check('search transitions to local train results', await page.locator('.railway-train-card').count() === 3);
  const resultsNarration = await page.evaluate(() => window.__handfreeSpoken.at(-1) || '');
  check('train results narrate numbered options and confirmation instructions', /Option 1:/.test(resultsNarration) && /Option 2:/.test(resultsNarration) && /Option 3:/.test(resultsNarration) && /choose option 1/.test(resultsNarration) && /confirm option/.test(resultsNarration));
  await page.getByRole('button', { name: 'Start guided flow' }).click();
  await page.waitForTimeout(80);
  await page.evaluate(() => window.__handfreeEmitSpeech('choose option 2'));
  await page.waitForTimeout(100);
  const selectionPrompt = await page.evaluate(() => window.__handfreeSpoken.at(-1) || '');
  check('voice option selection repeats the chosen train and asks for confirmation', /Option 2: Blue Line Intercity/.test(selectionPrompt) && /confirm option 2/.test(selectionPrompt) && await page.locator('.railway-hero-status small').innerText().then((text) => text.includes('Option 2 selected')));
  await page.evaluate(() => window.__handfreeEmitSpeech('confirm option 2'));
  await page.waitForTimeout(120);
  const confirmationPrompt = await page.evaluate(() => window.__handfreeSpoken.at(-1) || '');
  check('voice option confirmation opens passenger details', await page.getByRole('heading', { name: 'Passenger details' }).count() === 1 && /Option 2 confirmed/.test(confirmationPrompt) && await page.locator('.railway-hero-status small').innerText().then((text) => text.includes('Option 2 confirmed')));
  await page.getByRole('button', { name: 'Stop guided flow' }).click();
  await page.locator('#railway-name').fill('Asha Rao');
  await page.locator('#railway-contact').fill('9876543210');
  await page.locator('#railway-details').fill('Window seat requested for this local demonstration.');
  await page.locator('#railway-review').click();
  check('passenger details validate and reach review', await page.getByRole('heading', { name: 'Review before approval' }).count() === 1 && await page.getByText('Asha Rao').count() >= 1);
  const reviewNarration = await page.evaluate(() => window.__handfreeSpoken.at(-1) || '');
  check('review narrates the complete ticket and asks for final confirmation', /Mumbai Central.*Delhi Junction/.test(reviewNarration) && /Asha Rao/.test(reviewNarration) && /Window seat requested/.test(reviewNarration) && /confirm booking/.test(reviewNarration));
  await page.locator('#railway-review-approve').click();
  check('review requires an explicit approval step', await page.getByRole('heading', { name: 'Confirm the simulated booking?' }).count() === 1);
  await page.locator('#railway-confirm').click();
  check('confirmation creates a local reference', await page.getByRole('heading', { name: 'Your demo booking is complete' }).count() === 1 && /^HF-DEMO-\d{6}$/.test(await page.locator('.railway-reference strong').innerText()));

  await page.getByRole('button', { name: 'Open Railway Demo settings' }).click();
  check('settings drawer opens from the page', await page.getByRole('dialog', { name: 'Tune this demo' }).isVisible());
  await page.locator('#railway-cursor-size').fill('42');
  check('settings update is interactive', await page.locator('#railway-cursor-size').inputValue() === '42');
  await page.getByRole('dialog', { name: 'Tune this demo' }).getByRole('button', { name: 'Close Railway Demo settings' }).click();
  check('settings drawer closes cleanly', await page.getByRole('dialog', { name: 'Tune this demo' }).count() === 0);

  await page.getByRole('button', { name: 'Start another demo booking' }).click();
  await page.getByRole('button', { name: 'Start guided flow' }).click();
  await page.waitForTimeout(80);
  check('guided conversation starts without leaving the Railway page', await page.locator('.railway-voice-status').innerText().then((text) => text.includes('Guided conversation')) && new URL(page.url()).pathname.endsWith('/railway.html'));
  await page.evaluate(() => window.__handfreeEmitSpeech('from Mumbai Central'));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__handfreeEmitSpeech('station is Pune Junction'));
  await page.waitForTimeout(100);
  check('guided conversation maps natural station answers to the form', await page.locator('#railway-from').inputValue() === 'Mumbai Central' && await page.locator('#railway-to').inputValue() === 'Pune Junction');
  for (const answer of ['tomorrow', 'one way', 'two passengers', 'sleep']) {
    await page.evaluate((text) => window.__handfreeEmitSpeech(text), answer);
    await page.waitForTimeout(120);
  }
  await page.getByRole('heading', { name: 'Available demo trains' }).waitFor();
  check('guided conversation accepts the class answer and opens results', await page.locator('.railway-train-card').count() > 0 && await page.locator('#railway-class').inputValue() === 'sleeper');
  await page.getByRole('button', { name: 'Stop guided flow' }).click();
  check('guided conversation can return to command mode', await page.locator('.railway-voice-status').innerText().then((text) => text.includes('Voice commands')));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(80);
  const mobile = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  check('mobile layout has no horizontal overflow', mobile.scrollWidth <= mobile.clientWidth + 1);
  await page.screenshot({ path: join(artifactDir, 'railway-booking-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(artifactDir, 'railway-booking-desktop.png'), fullPage: true });
  check('reduced-motion stylesheet is present', await page.evaluate(() => Array.from(document.styleSheets).some((sheet) => { try { return sheet.cssRules ? Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('prefers-reduced-motion')) : false; } catch { return false; } })));

  if (errors.length) throw new Error(`Browser console errors:\n${errors.join('\n')}`);
  console.log(`PASS console-error scan (${checks.length} checks)`);
} finally {
  await browser.close();
}
