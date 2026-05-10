<?php

/**
 * dashboard_toggle.php — flip the v2-dashboard preference on the
 * current session and 302 into the matching main shell.
 *
 * Why this exists. main_screen.php picks between main.php (legacy)
 * and main_v2.php (SPA shell) based on `OPENEMR_DASHBOARD_V2` plus
 * `?v2=1` from the login form. Once the user is past the login,
 * there's no way to switch shells without a full re-login. This
 * endpoint exposes a session-scoped flag (`dashboard_v2_pref`) that
 * the router honors alongside the env/query signals, so a single
 * banner click swaps shells without touching credentials.
 *
 * Contract. POST { target=v2|v1 }. The session preference is set
 * (`true` for v2, `false` for v1), a fresh `token_main_php` is
 * minted exactly the way main_screen.php does, and the response is
 * a 302 to the corresponding main shell. Anonymous (unauthenticated)
 * sessions bounce back to the login screen.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @copyright Copyright (c) 2026 OpenCoreEMR Inc <https://opencoreemr.com/>
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

$sessionAllowWrite = true;
require_once(__DIR__ . '/../../globals.php');

use OpenEMR\Common\Csrf\CsrfUtils;
use OpenEMR\Common\Session\SessionUtil;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Common\Utils\RandomGenUtils;
use OpenEMR\Core\OEGlobalsBag;

$session = SessionWrapperFactory::getInstance()->getActiveSession();
$webRoot = OEGlobalsBag::getInstance()->getString('webroot');

$authUserId = $session->get('authUserID');
if (in_array($authUserId, [null, '', 0], true)) {
    $siteId = $session->get('site_id', 'default');
    $siteIdStr = is_string($siteId) ? $siteId : 'default';
    header('Location: ' . $webRoot . '/interface/login/login.php?site=' . urlencode($siteIdStr));
    exit();
}

if (filter_input(INPUT_SERVER, 'REQUEST_METHOD') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit();
}

$csrfPosted = filter_input(INPUT_POST, 'csrf_token_form');
if (!CsrfUtils::verifyCsrfToken(is_string($csrfPosted) ? $csrfPosted : '', $session)) {
    CsrfUtils::csrfNotVerified();
}

$target = filter_input(INPUT_POST, 'target');
$wantV2 = $target === 'v2';
SessionUtil::setSession('dashboard_v2_pref', $wantV2);

$tokenMainPhp = RandomGenUtils::createUniqueToken();
SessionUtil::setSession('token_main_php', $tokenMainPhp);

// Forward the active patient to the destination shell so the user
// stays on the same chart across the toggle. Both shells keep
// $_SESSION['pid'] in sync as the user picks patients (legacy via
// setpid(), the SPA via library/ajax/set_pt.php from commitSessionPid),
// so reading from session is the source of truth either direction.
//
// We pass it as a `pid` query param rather than relying on the
// destination to re-read $_SESSION at boot because:
//   - main_v2.php's React mount only auto-navigates to a patient when
//     it sees an explicit signal (sessionStorage OE_LAUNCH_PID after
//     OAuth, or — with this change — `?pid=` from the toggle URL).
//   - main.php's Knockout attendant bar boots empty and waits for an
//     iframe to call `top.set_pid()`; the legacy shell uses the same
//     `?pid=` hint to fire setPatient() at body-ready.
$sessionPid = $session->get('pid');
$pidQuery = '';
if (is_int($sessionPid) && $sessionPid > 0) {
    $pidQuery = '&pid=' . urlencode((string) $sessionPid);
} elseif (is_string($sessionPid) && ctype_digit($sessionPid) && $sessionPid !== '0') {
    $pidQuery = '&pid=' . urlencode($sessionPid);
}

$shell = $wantV2 ? 'main_v2.php' : 'main.php';
header('Location: ' . $webRoot . '/interface/main/tabs/' . $shell . '?token_main=' . urlencode($tokenMainPhp) . $pidQuery);
exit();
