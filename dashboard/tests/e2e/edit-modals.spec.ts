import { expect, test } from '@playwright/test';

// E2E for the in-page edit modals. Like the existing patient-context
// and copilot specs, this runs against the standalone Vite dev
// server (no OpenEMR PHP backend), so we mount the modals from the
// dev-only `/edit-sandbox` route and intercept the editor endpoint
// at the network layer.
//
// The sandbox is gated behind `import.meta.env.DEV` in the route
// registration, so production bundles don't expose this surface.
//
// What these tests verify (the load-bearing contracts):
//   - Each modal renders with the right title and required-field
//     gating on its Save button.
//   - On Save, the SPA POSTs to the dashboard-editor module's
//     ajax.php endpoint with the right `action`, the page-level
//     CSRF token, and a body shape the PHP controller can consume.
//   - Successful responses dismiss the modal and surface the
//     "Saved: <kind>" affordance for the harness to assert on.
//   - Failure responses keep the modal open with the typed error
//     message in view.

const ENDPOINT_GLOB =
  '**/interface/modules/custom_modules/oe-module-dashboard-editor/public/ajax.php';

async function setUpCsrf(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    // The dashboard reads `window.csrf_token_js` and refuses to
    // call the editor when it's missing. The host page (main_v2.php)
    // sets it from the OpenEMR session; the sandbox simulates that.
    (window as unknown as { csrf_token_js?: string }).csrf_token_js = 'csrf-e2e';
  });
}

test.describe('dashboard edit modals', () => {
  test('Allergy modal: validates required field and POSTs save_allergy', async ({ page }) => {
    await setUpCsrf(page);

    let captured: { url: string; body: string } | null = null;
    await page.route(ENDPOINT_GLOB, async (route) => {
      const req = route.request();
      captured = { url: req.url(), body: req.postData() ?? '' };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { uuid: 'a-1' } }),
      });
    });

    await page.goto('/#/edit-sandbox');
    await page.getByTestId('sandbox-open-allergy').click();

    // Save is disabled until the doctor types an allergen.
    await expect(page.getByTestId('allergy-edit-modal-save')).toBeDisabled();

    await page.getByTestId('allergy-title-input').fill('Penicillin');
    await page.getByTestId('allergy-severity-select').selectOption('high');
    await page.getByTestId('allergy-edit-modal-save').click();

    await expect(page.getByTestId('sandbox-saved')).toContainText('allergy');
    expect(captured).not.toBeNull();
    expect(captured!.url).toContain('oe-module-dashboard-editor');
    const body = JSON.parse(captured!.body) as Record<string, unknown>;
    expect(body.action).toBe('save_allergy');
    expect(body.csrf_token).toBe('csrf-e2e');
    expect(body.title).toBe('Penicillin');
    expect(body.severity).toBe('high');
  });

  test('Problem modal: POSTs save_problem on submit', async ({ page }) => {
    await setUpCsrf(page);

    let captured: string | null = null;
    await page.route(ENDPOINT_GLOB, async (route) => {
      captured = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { uuid: 'c-1' } }),
      });
    });

    await page.goto('/#/edit-sandbox');
    await page.getByTestId('sandbox-open-problem').click();
    await page.getByTestId('problem-title-input').fill('Type 2 diabetes');
    await page.getByTestId('problem-diagnosis-input').fill('ICD10:E11.9');
    await page.getByTestId('problem-edit-modal-save').click();

    await expect(page.getByTestId('sandbox-saved')).toContainText('problem');
    const body = JSON.parse(captured ?? '{}') as Record<string, unknown>;
    expect(body.action).toBe('save_problem');
    expect(body.title).toBe('Type 2 diabetes');
    expect(body.diagnosis).toBe('ICD10:E11.9');
  });

  test('Medication modal: POSTs save_medication and bundles dose into title', async ({
    page,
  }) => {
    await setUpCsrf(page);

    let captured: string | null = null;
    await page.route(ENDPOINT_GLOB, async (route) => {
      captured = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, id: 5, uuid: 'm-1' }),
      });
    });

    await page.goto('/#/edit-sandbox');
    await page.getByTestId('sandbox-open-medication').click();
    await page.getByTestId('medication-title-input').fill('Metformin');
    await page.getByTestId('medication-dose-input').fill('500 mg PO BID');
    await page.getByTestId('medication-edit-modal-save').click();

    await expect(page.getByTestId('sandbox-saved')).toContainText('medication');
    const body = JSON.parse(captured ?? '{}') as Record<string, unknown>;
    expect(body.action).toBe('save_medication');
    expect(body.title).toBe('Metformin 500 mg PO BID');
  });

  test('Prescription modal: POSTs save_prescription with the legacy field shape', async ({
    page,
  }) => {
    await setUpCsrf(page);

    let captured: string | null = null;
    await page.route(ENDPOINT_GLOB, async (route) => {
      captured = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { uuid: 'rx-1' } }),
      });
    });

    await page.goto('/#/edit-sandbox');
    await page.getByTestId('sandbox-open-prescription').click();
    await page.getByTestId('rx-drug-input').fill('Lisinopril 10 mg');
    await page.getByTestId('rx-dosage-input').fill('10 mg');
    await page.getByTestId('rx-quantity-input').fill('30');
    await page.getByTestId('rx-route-select').selectOption('oral');
    await page.getByTestId('prescription-edit-modal-save').click();

    await expect(page.getByTestId('sandbox-saved')).toContainText('prescription');
    const body = JSON.parse(captured ?? '{}') as Record<string, unknown>;
    expect(body.action).toBe('save_prescription');
    expect(body.drug).toBe('Lisinopril 10 mg');
    expect(body.dosage).toBe('10 mg');
    expect(body.quantity).toBe('30');
    expect(body.route).toBe('oral');
  });

  test('Lab result modal: requires code + value before submitting', async ({ page }) => {
    await setUpCsrf(page);

    let captured: string | null = null;
    await page.route(ENDPOINT_GLOB, async (route) => {
      captured = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, procedure_result_id: 99 }),
      });
    });

    await page.goto('/#/edit-sandbox');
    await page.getByTestId('sandbox-open-lab').click();
    // Save is disabled until both code and value are filled.
    await expect(page.getByTestId('lab-result-edit-modal-save')).toBeDisabled();
    await page.getByTestId('lab-code-input').fill('4548-4');
    await page.getByTestId('lab-label-input').fill('Hemoglobin A1c');
    await page.getByTestId('lab-value-input').fill('6.8');
    await page.getByTestId('lab-units-input').fill('%');
    await page.getByTestId('lab-result-edit-modal-save').click();

    await expect(page.getByTestId('sandbox-saved')).toContainText('lab');
    const body = JSON.parse(captured ?? '{}') as Record<string, unknown>;
    expect(body.action).toBe('save_lab_result');
    expect(body.result_code).toBe('4548-4');
    expect(body.result).toBe('6.8');
    expect(body.units).toBe('%');
  });

  test('Vitals modal: rejects empty submit and POSTs filled vitals on save', async ({
    page,
  }) => {
    await setUpCsrf(page);

    let captured: string | null = null;
    await page.route(ENDPOINT_GLOB, async (route) => {
      captured = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, saved: { id: 1 } }),
      });
    });

    await page.goto('/#/edit-sandbox');
    await page.getByTestId('sandbox-open-vitals').click();

    // Empty submit surfaces the inline error and doesn't fire fetch.
    await page.getByTestId('vitals-edit-modal-save').click();
    await expect(page.getByTestId('vitals-edit-modal-error')).toContainText(
      /at least one vital/i,
    );
    expect(captured).toBeNull();

    await page.getByTestId('vitals-bps-input').fill('128');
    await page.getByTestId('vitals-bpd-input').fill('82');
    await page.getByTestId('vitals-pulse-input').fill('72');
    await page.getByTestId('vitals-temp-input').fill('98.6');
    await page.getByTestId('vitals-edit-modal-save').click();

    await expect(page.getByTestId('sandbox-saved')).toContainText('vitals');
    const body = JSON.parse(captured ?? '{}') as Record<string, unknown>;
    expect(body.action).toBe('save_vitals');
    expect(body.bps).toBe('128');
    expect(body.bpd).toBe('82');
    expect(body.pulse).toBe('72');
    expect(body.temperature).toBe('98.6');
  });

  test('Server error: keeps modal open and renders the typed message', async ({ page }) => {
    await setUpCsrf(page);

    await page.route(ENDPOINT_GLOB, async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'validation_failed' }),
      });
    });

    await page.goto('/#/edit-sandbox');
    await page.getByTestId('sandbox-open-allergy').click();
    await page.getByTestId('allergy-title-input').fill('Sulfa');
    await page.getByTestId('allergy-edit-modal-save').click();

    await expect(page.getByTestId('allergy-edit-modal-error')).toContainText(
      /correct the highlighted/i,
    );
    // The modal stays open so the doctor can fix and retry.
    await expect(page.getByTestId('allergy-edit-modal')).toBeVisible();
    // Save is back to enabled.
    await expect(page.getByTestId('allergy-edit-modal-save')).toBeEnabled();
  });

  test('Escape key closes the modal without firing a save', async ({ page }) => {
    await setUpCsrf(page);

    let called = false;
    await page.route(ENDPOINT_GLOB, async (route) => {
      called = true;
      await route.fulfill({ status: 200, body: '{}' });
    });

    await page.goto('/#/edit-sandbox');
    await page.getByTestId('sandbox-open-problem').click();
    await page.getByTestId('problem-title-input').fill('Hypertension');
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('problem-edit-modal')).toHaveCount(0);
    expect(called).toBe(false);
  });
});
