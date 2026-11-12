import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://www.etihad.com/en-in/');
  await page.getByRole('tab', { name: 'One way' }).click();
  await page.getByRole('combobox', { name: 'Flying to' }).click();
  await page.getByRole('option', { name: 'airport Abu Dhabi, United' }).click();
  await page.getByText('Business').click();
  await page.getByRole('radio', { name: 'Business' }).check();
  await page.getByText('First').click();
  await page.getByRole('radio', { name: 'First' }).check();
  await page.getByText('Business').click();
  await page.getByRole('radio', { name: 'Business' }).check();
  await page.getByText('Economy', { exact: true }).click();
  await page.getByRole('radio', { name: 'Economy' }).check();
  await page.getByText('Business').click();
  await page.getByRole('radio', { name: 'Business' }).check();
  await page.getByText('Economy', { exact: true }).click();
  await page.getByRole('radio', { name: 'Economy' }).check();
  await page.getByText('Business').click();
  await page.getByRole('radio', { name: 'Business' }).check();
  await page.getByText('First').click();
  await page.getByRole('radio', { name: 'First' }).check();
  await page.getByText('Business').click();
  await page.getByRole('radio', { name: 'Business' }).check();
  await page.getByText('First').click();
  await page.getByRole('radio', { name: 'First' }).check();
});