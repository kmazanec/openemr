<?php

/**
 * _dashboard_toggle_banner.php — thin banner above the top nav that
 * lets the user flip between the legacy main.php shell and the
 * main_v2.php SPA shell without re-authenticating.
 *
 * Included from both main.php and main_v2.php immediately after
 * <body> opens, ahead of the #mainBox wrapper. Posts to
 * dashboard_toggle.php which sets `dashboard_v2_pref` on the session
 * and 302s into the matching shell.
 *
 * Caller contract: the including file must already have imported
 * `OpenEMR\Common\Csrf\CsrfUtils` and must define `$bannerIsV2` as a
 * bool indicating the current shell.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @copyright Copyright (c) 2026 OpenCoreEMR Inc <https://opencoreemr.com/>
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

if (!isset($bannerIsV2) || !is_bool($bannerIsV2)) {
    return;
}

$bannerSession = OpenEMR\Common\Session\SessionWrapperFactory::getInstance()->getActiveSession();

$bannerTarget = $bannerIsV2 ? 'v1' : 'v2';
$bannerCurrentLabel = $bannerIsV2
    ? xl('Using new dashboard (v2).')
    : xl('Using legacy dashboard.');
$bannerSwitchLabel = $bannerIsV2
    ? xl('Switch to legacy dashboard')
    : xl('Switch to new dashboard');
?>
<form method="POST"
      action="<?php echo attr(OpenEMR\Core\OEGlobalsBag::getInstance()->getWebRoot()); ?>/interface/main/tabs/dashboard_toggle.php"
      class="oe-dashboard-toggle-banner"
      role="region"
      aria-label="<?php echo xla('Dashboard version selector'); ?>">
    <input type="hidden" name="csrf_token_form" value="<?php echo attr(OpenEMR\Common\Csrf\CsrfUtils::collectCsrfToken($bannerSession)); ?>">
    <input type="hidden" name="target" value="<?php echo attr($bannerTarget); ?>">
    <span class="oe-dashboard-toggle-banner__label"><?php echo text($bannerCurrentLabel); ?></span>
    <button type="submit" class="oe-dashboard-toggle-banner__button">
        <?php echo text($bannerSwitchLabel); ?> &rarr;
    </button>
</form>
<style>
    .oe-dashboard-toggle-banner {
        margin: 0;
        padding: 0.25rem 0.75rem;
        background: #1c3661;
        color: #f4f7fb;
        font-size: 0.78rem;
        line-height: 1.3;
        display: flex;
        align-items: center;
        gap: 0.6rem;
        border-bottom: 1px solid #142544;
    }
    .oe-dashboard-toggle-banner__label {
        flex: 1 1 auto;
    }
    .oe-dashboard-toggle-banner__button {
        flex: 0 0 auto;
        background: transparent;
        color: inherit;
        border: 1px solid rgba(255, 255, 255, 0.4);
        border-radius: 3px;
        padding: 0.1rem 0.55rem;
        font-size: inherit;
        cursor: pointer;
    }
    .oe-dashboard-toggle-banner__button:hover {
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.7);
    }
    .oe-dashboard-toggle-banner__button:focus-visible {
        outline: 2px solid #ffd24c;
        outline-offset: 1px;
    }
</style>
