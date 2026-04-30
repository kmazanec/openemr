<?php

/**
 * Settings panel for the Clinical Co-Pilot module.
 *
 * Loaded inside an iframe by `interface/modules/zend_modules/module/Installer/
 * view/installer/installer/configure.phtml` when the user clicks the cog
 * icon on the module's row in Modules → Manage Modules. The configure view
 * falls back to embedding `<iframe src="…/moduleConfig.php">` for any
 * custom module (`type=0`) that doesn't register a Laminas
 * SetupController or ModuleconfigForm — which is our case.
 *
 * Why this file holds the documentation rather than the help (?) icon: the
 * installer JS unconditionally reloads the modules iframe after every
 * `manage` action, so any inline content the help endpoint returns is
 * wiped before it can be read. The settings iframe is rendered as a
 * persistent child frame inside the configure view, so it isn't subject
 * to that reload. Module operators read this panel for the same reason
 * they'd open the help — to understand what the module does and how data
 * is logged.
 *
 * Content covers: what the module does, when PHI leaves OpenEMR, what
 * gets logged, how to review and manage disclosures, and the safety
 * posture. It is intentionally HIPAA/operations-focused — the legal
 * analysis lives in docs/.
 *
 * Access is gated to admin users via OpenEMR's ACL — the same gate
 * Modules → Manage Modules itself enforces upstream — so even though this
 * file is reachable by URL, it 403s for non-admins.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../../globals.php';

use OpenEMR\Common\Acl\AccessDeniedHelper;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Core\Header;

if (!AclMain::aclCheckCore('admin', 'manage_modules')) {
    AccessDeniedHelper::denyWithTemplate(
        'ACL check failed for admin/manage_modules: Clinical Co-Pilot Settings',
        xl('Clinical Co-Pilot Settings'),
    );
}

// Marker the upstream installer view checks for to confirm the file ran
// as a config (not a dependency-resolution include). Kept for parity with
// other custom modules even though we don't branch on it.
$module_config = 1;
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title><?php echo xlt('Clinical Co-Pilot Settings'); ?></title>
<?php Header::setupHeader(['common']); ?>
<style>
  body { padding: 1.5em 2em 3em; max-width: 820px; }
  h2 { margin-top: 0; padding-bottom: 0.4em; border-bottom: 1px solid #ddd;
       font-size: 1.4em; }
  h3 { font-size: 1.05em; margin-top: 1.6em; color: #333; }
  ul { padding-left: 1.4em; }
  li { margin: 0.4em 0; }
  .note { font-size: 0.9em; color: #666; margin-top: 2em;
          padding-top: 1em; border-top: 1px solid #eee; }
  .placeholder { font-style: italic; color: #888; }
</style>
</head>
<body>

<h2><?php echo xlt('Clinical Co-Pilot — How it works'); ?></h2>

<h3><?php echo xlt('What it does'); ?></h3>
<p>
  <?php echo xlt(
      'The Clinical Co-Pilot summarizes the current patient\'s chart for the '
      . 'treating clinician at the point of care. The clinician opens a patient '
      . 'chart and sees a briefing covering active diagnoses, current medications, '
      . 'recent labs, allergies, recent encounters, and (when applicable) the '
      . 'appointment context. Every claim in the briefing is cited back to the '
      . 'OpenEMR record it came from.'
  ); ?>
</p>

<h3><?php echo xlt('When PHI leaves OpenEMR'); ?></h3>
<p>
  <?php echo xlt(
      'The module sends a minimized chart snapshot to a sibling agent service '
      . 'on the same private network, which calls Anthropic\'s Claude API under '
      . 'a Business Associate Agreement. The snapshot is built fresh on each '
      . 'request and contains only the data categories the request needs '
      . '(diagnoses, medications, allergies, labs, encounters, appointment). '
      . 'It never contains free-text encounter notes, billing data, contact '
      . 'information, or the social-security number.'
  ); ?>
</p>
<p>
  <?php echo xlt(
      'This use is classified as treatment under HIPAA §164.506 — the AI '
      . 'tool is invoked by the treating clinician on the current patient\'s '
      . 'own chart for the current encounter. The Anthropic BAA is the '
      . 'load-bearing element of that classification.'
  ); ?>
</p>

<h3><?php echo xlt('What gets logged'); ?></h3>
<p><?php echo xlt('Every agent request produces two log rows:'); ?></p>
<ul>
  <li>
    <strong><?php echo xlt('Patient disclosure log'); ?></strong> —
    <?php echo xlt(
        'one row per (clinician, patient, day) in OpenEMR\'s standard '
        . 'extended_log table, with disclosure type "AI-assisted treatment" '
        . 'and recipient "Clinical Co-Pilot Agent". Visible to compliance '
        . 'officers via the patient summary\'s Disclosures view, and '
        . 'included in any HIPAA Accounting of Disclosures (§164.528) '
        . 'report run for that patient.'
    ); ?>
  </li>
  <li>
    <strong><?php echo xlt('Engineering request log'); ?></strong> —
    <?php echo xlt(
        'one row per request in the agent_request_log table. Records the '
        . 'actor, patient, action, request id, data categories disclosed, '
        . 'and timestamp. Used for cost analysis, idempotency, and forensic '
        . 'debugging. Does not contain prompt or response bodies.'
    ); ?>
  </li>
</ul>
<p>
  <em><?php echo xlt('Neither log stores the prompt sent to the LLM or the response received. The logs record that data left, not what the data was.'); ?></em>
</p>

<h3><?php echo xlt('How to review and manage'); ?></h3>
<ul>
  <li><?php echo xlt('Per-patient disclosure history: Patient summary → Disclosures (requires the patients/disclosure ACL).'); ?></li>
  <li><?php echo xlt('Engineering request history: query the agent_request_log table directly. Indexed by (patient_pid, disclosed_at) and (actor_user_id, disclosed_at) for compliance pulls and cost rollups.'); ?></li>
  <li><?php echo xlt('To stop the module from sending data: disable the module from the Manage Modules page. The proxy controller fails closed when disabled and no request reaches the agent service.'); ?></li>
  <li><?php echo xlt('To redact a logged disclosure (e.g. correcting a record): the extended_log row is editable from the patient\'s Disclosures view by users with the patients/disclosure write ACL.'); ?></li>
</ul>

<h3><?php echo xlt('Safety posture'); ?></h3>
<ul>
  <li><?php echo xlt('Bearer token between OpenEMR and the agent service is minted per-request, scoped to the current patient and action, with a 5-minute lifetime.'); ?></li>
  <li><?php echo xlt('The agent service rejects any request whose token does not pass JWT verification against OpenEMR\'s JWKS.'); ?></li>
  <li><?php echo xlt('Every claim in a briefing must cite a specific OpenEMR record. Claims without sources are stripped before display.'); ?></li>
  <li><?php echo xlt('If allergy or medication data cannot be loaded, the briefing fails closed — it does not display a partial summary.'); ?></li>
</ul>

<h3><?php echo xlt('Configurable settings'); ?></h3>
<p class="placeholder">
  <?php echo xlt('No tunable settings yet. Future iterations will surface controls for the data-category set, retention windows, and per-clinician overrides here.'); ?>
</p>

<p class="note">
  <?php echo xlt('For implementation details and the full HIPAA analysis, see the project documentation under docs/ in the repository.'); ?>
</p>

</body>
</html>
