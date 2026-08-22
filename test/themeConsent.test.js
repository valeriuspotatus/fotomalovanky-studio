import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

test('theme blocks progression, survives upload rerenders, and preserves acceptance time', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(new URL('../shopify-theme/test-fixture.html', import.meta.url).href);

  const form = page.locator('form');
  const consent = form.locator('[data-fma-photo-authorization-checkbox]');
  const upload = form.locator('input[type=file]');
  const submit = form.locator('button[name=add]');
  assert.equal(await consent.isChecked(), false);
  assert.equal(await upload.isDisabled(), true);
  await submit.click({ force: true });
  assert.equal(await form.locator('[role=alert]').isVisible(), true);

  await consent.check();
  assert.equal(await upload.isEnabled(), true);
  const timestamp = await form.locator('[name="properties[_Photo authorization accepted at]"]').inputValue();
  await page.evaluate(() => {
    const old = document.querySelector('.tpo_option-container');
    const replacement = old.cloneNode(true);
    old.replaceWith(replacement);
  });
  await page.waitForFunction(() => document.querySelector('input[type=file]').disabled === false);
  assert.equal(await form.locator('[name="properties[_Photo authorization accepted at]"]').inputValue(), timestamp);

  await page.locator('input[value*="PDF"]').check();
  assert.equal(await form.locator('[data-fma-digital-performance]').isVisible(), true);
  assert.equal(await submit.getAttribute('aria-disabled'), 'true');
  await form.locator('[data-fma-digital-performance-checkbox]').check();
  assert.equal(await submit.getAttribute('aria-disabled'), 'false');

  await page.reload();
  await page.locator('form [data-fma-photo-authorization-checkbox]').check();
  await page.evaluate(() => {
    document.querySelectorAll('input[type=radio]').forEach((input) => input.remove());
    const select = document.createElement('select');
    select.innerHTML = '<option value="print">Tisk</option><option value="digital">PDF online</option>';
    document.querySelector('form').prepend(select);
    select.value = 'digital';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(await form.locator('[data-fma-digital-performance]').isVisible(), true);
  assert.equal(await form.locator('[data-fma-digital-performance-checkbox]').isChecked(), false);
  assert.equal(await submit.getAttribute('aria-disabled'), 'true');

  await page.setViewportSize({ width: 1280, height: 900 });
  await consent.focus();
  await page.keyboard.press('Space');
  assert.equal(await upload.isDisabled(), true);
});
