<?php

/**
 * main_v2_resume.php — post-auth landing page that re-enters the
 * dashboard SPA shell (main_v2.php) after the SMART OIDC dance.
 *
 * Why this exists. main_v2.php requires a `token_main` query
 * parameter that must match a session value set by main_screen.php.
 * The SMART OIDC redirect chain lands the browser on
 * /dashboard/auth/callback, which is owned by the SPA — there's no
 * round-trip through main_screen.php to mint a fresh token_main.
 * Without this helper, the SPA after auth would have to navigate
 * back to main_v2.php with a stale (or missing) token, which the
 * legacy session check rejects.
 *
 * What it does. Validates that the OpenEMR core session is still
 * authenticated (the same cookie that authorized the OAuth flow),
 * mints a fresh token_main exactly the way main_screen.php does,
 * and 302s to main_v2.php?token_main=<new>. The SMART session that
 * fhirclient just stored in window.sessionStorage survives the
 * redirect, so the SPA mounts with a ready FHIR client.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @copyright Copyright (c) 2026 OpenCoreEMR Inc <https://opencoreemr.com/>
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

$sessionAllowWrite = true;
require_once(__DIR__ . '/../../globals.php');

use OpenEMR\Common\Session\SessionUtil;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Common\Utils\RandomGenUtils;
use OpenEMR\Core\OEGlobalsBag;

$session = SessionWrapperFactory::getInstance()->getActiveSession();
$webRoot = OEGlobalsBag::getInstance()->getString('webroot');

// The OpenEMR core session must be authenticated. authUserID is set
// by AuthUtils on a successful login. If it's missing, the user is
// not logged in (or their session timed out) and we send them back
// to the login screen.
$authUserId = $session->get('authUserID');
if (in_array($authUserId, [null, '', 0], true)) {
    $siteId = $session->get('site_id', 'default');
    $siteIdStr = is_string($siteId) ? $siteId : 'default';
    header('Location: ' . $webRoot . '/interface/login/login.php?site=' . urlencode($siteIdStr));
    exit();
}

// Mint a fresh token_main, exactly as main_screen.php does.
$tokenMainPhp = RandomGenUtils::createUniqueToken();
SessionUtil::setSession('token_main_php', $tokenMainPhp);

header('Location: ' . $webRoot . '/interface/main/tabs/main_v2.php?token_main=' . urlencode($tokenMainPhp));
exit();
