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
use OpenEMR\Modules\ClinicalCopilot\Auth\FhirUserResolutionException;
use OpenEMR\Modules\ClinicalCopilot\Auth\FhirUserResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Auth\SessionContext;
use OpenEMR\Modules\ClinicalCopilot\Controller\AgentProxyController;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDbalConnection;
use OpenEMR\Modules\ClinicalCopilot\Schedule\MorningPrepGate;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$session = SessionWrapperFactory::getInstance()->getActiveSession();
$globals = OEGlobalsBag::getInstance();

// Action names are drawn from PolicyGate's allowlist, which contains
// underscore-separated identifiers like `latest_conversation`. We
// cannot use Symfony's `getAlnum()` here because it strips
// underscores and turns those names into ones the gate then rejects
// as `UnknownAction`. PolicyGate is still the trust point — this is
// just a shape filter at the boundary.
$actionRaw = $request->query->get('action');
$action = (is_string($actionRaw) && preg_match('/\A[a-z_]{1,64}\z/', $actionRaw) === 1)
    ? $actionRaw
    : '';

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

// Resolve fhirUser identity *before* the policy gate runs. The agent's
// authorization model assumes `sub` is a Practitioner UUID — falling back
// to authUserID (an integer in users.id) would silently grant the wrong
// identity to anything that trusts the claim. Fail closed if the staff
// row can't be found or the user isn't a Practitioner-eligible role.
$siteAddr = $globals->getString('site_addr_oath');
$webroot = $globals->getWebRoot();
$fhirBaseUrl = $siteAddr . $webroot . '/apis/' . $siteId . '/fhir';
$issuer = $siteAddr . $webroot . '/oauth2/' . $siteId;

$resolvedFhirUser = null;
if ($authUserId !== '') {
    try {
        $resolvedFhirUser = (new FhirUserResolver())->resolve($authUserId, $fhirBaseUrl);
    } catch (FhirUserResolutionException) {
        // Surface as MissingSession so the gate emits a 401 — same UX as
        // hitting the endpoint without a session. The reason is logged
        // server-side; we never leak the resolution failure detail to the
        // client.
        $resolvedFhirUser = null;
    }
}

$gate = new PolicyGate();
$context = new SessionContext(
    authUserId: $authUserId,
    authUser: $authUser,
    siteId: $siteId,
    patientPid: $sessionPid,
    fhirUser: $resolvedFhirUser,
);

// §4.7: pull through the per-action whitelisted extras (force-resume
// conversation id, history pagination cursor + limit). The proxy
// controller re-checks the allowlist on its side — this is a defense-
// in-depth filter, not the policy point itself.
$extraAllowlist = AgentProxyController::EXTRA_QUERY_PARAM_ALLOWLIST[$action] ?? [];
$extraQueryParams = [];
foreach ($extraAllowlist as $paramName) {
    $raw = $request->query->get($paramName);
    if (is_string($raw) && $raw !== '') {
        $extraQueryParams[$paramName] = $raw;
    }
}

$agentRequest = new AgentRequest(
    action: $action,
    siteId: $siteId,
    requestedPatientPid: $requestedPid,
    requestedScopes: $gate->defaultScopesFor($action),
    extraQueryParams: $extraQueryParams,
);

// §5.4 short-circuit: don't mint a token or call upstream when the
// schedule-view annotations action runs against a practitioner who has
// not opted into morning-prep. The agent's own route returns
// `{briefings: []}` for the cold-cache case, so the contract is
// identical — but the round-trip is wasted work on every page load.
if ($action === 'schedule_briefings' && $resolvedFhirUser !== null) {
    $morningPrepGate = new MorningPrepGate(new SettingsRepository(AgentDbalConnection::get()));
    if (!$morningPrepGate->isEnabledFor($resolvedFhirUser->uuid)) {
        http_response_code(200);
        header('Content-Type: application/json');
        echo json_encode(['briefings' => []], JSON_THROW_ON_ERROR);
        return;
    }
}

$body = $request->getContent();

$agentBaseUrlEnv = getenv('AGENT_SERVICE_URL');
$agentBaseUrl = is_string($agentBaseUrlEnv) && $agentBaseUrlEnv !== ''
    ? $agentBaseUrlEnv
    : 'http://agent:8080';

$controller = AgentProxyController::fromEnvironment($agentBaseUrl, $issuer);
$controller->dispatch($context, $agentRequest, $body);
