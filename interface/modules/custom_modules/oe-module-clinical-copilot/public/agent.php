<?php

/**
 * Browser entry point for the Agent proxy.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

// OpenEMR boots the session, autoloader, and globals here. Must run before
// any other code in this file.
require_once __DIR__ . '/../../../../globals.php';

use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentRequest;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Auth\SessionContext;
use OpenEMR\Modules\ClinicalCopilot\Controller\AgentProxyController;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$session = SessionWrapperFactory::getInstance()->getActiveSession();
$globals = OEGlobalsBag::getInstance();

$action = $request->query->getAlnum('action');

$pidParam = $request->query->get('pid');
$requestedPid = (is_string($pidParam) && $pidParam !== '' && $pidParam !== '0')
    ? $pidParam
    : null;

$siteIdRaw = $session->get('site_id');
$siteId = is_string($siteIdRaw) && $siteIdRaw !== '' ? $siteIdRaw : 'default';

$authUserIdRaw = $session->get('authUserID');
$authUserId = is_scalar($authUserIdRaw) ? (string) $authUserIdRaw : '';

$authUserRaw = $session->get('authUser');
$authUser = is_string($authUserRaw) ? $authUserRaw : '';

$sessionPidRaw = $session->get('pid');
$sessionPid = (is_scalar($sessionPidRaw) && $sessionPidRaw !== '' && $sessionPidRaw !== 0)
    ? (string) $sessionPidRaw
    : null;

$fhirUserUuidRaw = $session->get('fhirUserUuid');
$fhirUserUuid = is_string($fhirUserUuidRaw) && $fhirUserUuidRaw !== ''
    ? $fhirUserUuidRaw
    : null;

$gate = new PolicyGate();
$context = new SessionContext(
    authUserId: $authUserId,
    authUser: $authUser,
    siteId: $siteId,
    patientPid: $sessionPid,
    fhirUserUuid: $fhirUserUuid,
);

$agentRequest = new AgentRequest(
    action: $action,
    siteId: $siteId,
    requestedPatientPid: $requestedPid,
    requestedScopes: $gate->defaultScopesFor($action),
);

$body = $request->getContent();

$agentBaseUrlEnv = getenv('AGENT_SERVICE_URL');
$agentBaseUrl = is_string($agentBaseUrlEnv) && $agentBaseUrlEnv !== ''
    ? $agentBaseUrlEnv
    : 'http://agent:8080';

$issuer = $globals->getString('site_addr_oath') . $globals->getWebRoot() . '/oauth2/' . $siteId;

$controller = AgentProxyController::fromEnvironment($agentBaseUrl, $issuer);
$controller->dispatch($context, $agentRequest, $body);
