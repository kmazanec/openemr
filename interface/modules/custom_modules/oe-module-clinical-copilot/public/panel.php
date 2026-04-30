<?php

/**
 * Clinical Co-Pilot panel page.
 *
 * Renders the per-patient briefing UI inside OpenEMR's chrome. The page
 * itself is a thin Twig template; all of the work happens client-side in
 * `public/js/panel.js`, which opens an SSE connection to the agent proxy
 * and renders sections + citations + failure states as events arrive.
 *
 * Routing:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/public/panel.php?pid=42
 *
 * The summary-card entry point (added in §3.4) links here with the active
 * patient's pid. The panel reuses the same OpenEMR session, so no new
 * authentication is needed.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../../../globals.php';

use OpenEMR\Common\Acl\AccessDeniedHelper;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Common\Twig\TwigContainer;
use OpenEMR\Core\Header;
use OpenEMR\Core\OEGlobalsBag;
use Symfony\Component\HttpFoundation\Request;

if (!AclMain::aclCheckCore('patients', 'med')) {
    AccessDeniedHelper::denyWithTemplate(
        'ACL check failed for patients/med: Clinical Co-Pilot',
        xl('Clinical Co-Pilot'),
    );
}

$request = Request::createFromGlobals();
$session = SessionWrapperFactory::getInstance()->getActiveSession();

$pidParam = $request->query->get('pid');
$pidString = (is_string($pidParam) && $pidParam !== '' && $pidParam !== '0') ? $pidParam : null;
$pid = ($pidString !== null && ctype_digit($pidString)) ? (int) $pidString : null;

$sessionPidRaw = $session->get('pid');
$sessionPid = is_scalar($sessionPidRaw) ? (int) $sessionPidRaw : 0;

if ($pid === null || $pid !== $sessionPid) {
    AccessDeniedHelper::denyWithTemplate(
        'Clinical Co-Pilot panel: requested pid does not match the active session patient',
        xl('Clinical Co-Pilot'),
    );
}

$globals = OEGlobalsBag::getInstance();
$webroot = $globals->getWebRoot();
$proxyUrl = $webroot . '/interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php';

$twig = (new TwigContainer(__DIR__ . '/../templates'))->getTwig();

$siteIdRaw = $session->get('site_id');
$siteId = is_string($siteIdRaw) && $siteIdRaw !== '' ? $siteIdRaw : 'default';

echo $twig->render('panel.html.twig', [
    'cssUrl' => $webroot
        . '/interface/modules/custom_modules/oe-module-clinical-copilot/public/css/panel.css',
    'jsUrl' => $webroot
        . '/interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js',
    'proxyUrl' => $proxyUrl,
    'pid' => $pid,
    'siteId' => $siteId,
    'commonHeader' => Header::setupHeader([], false),
]);
