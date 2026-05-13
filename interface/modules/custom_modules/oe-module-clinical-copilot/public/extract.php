<?php

/**
 * §B.8 Browser entry point for the ingestion-pipeline trigger.
 *
 * Path A (panel upload during a conversation): the panel POSTs the
 * just-uploaded document's metadata, OpenEMR mints a JWT scoped to the
 * pipeline's needs, forwards to the agent's `/v1/agent/extract`
 * route, and pipes the SSE response back to the browser.
 *
 * This entry point uses the **proxy** pattern (session-based auth,
 * outbound JWT mint) and lives next to `agent.php`. The bearer-token
 * pattern that `snapshot/*.php` endpoints use is for agent-inbound
 * traffic (the agent calling back to OpenEMR with a JWT it already
 * holds); the trigger goes the other direction — browser → OpenEMR →
 * agent — so it belongs alongside the other browser-inbound entry,
 * not under `snapshot/`.
 *
 * Request shape:
 *   POST /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/extract.php
 *   Body (JSON): {pid, document_uuid, doc_type, trigger_source,
 *                 canonical_ext?, conversation_id?}
 *
 * Response:
 *   text/event-stream — pipeline.* events from the agent
 *   400 / 401 / 403 / 502 — JSON error envelope
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../../../globals.php';

use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Auth\FhirUserResolutionException;
use OpenEMR\Modules\ClinicalCopilot\Auth\FhirUserResolver;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap\AgentEndpointBootstrap;
use OpenEMR\Modules\ClinicalCopilot\Controller\ExtractController;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$session = SessionWrapperFactory::getInstance()->getActiveSession();
$globals = OEGlobalsBag::getInstance();

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

$siteAddr = $globals->getString('site_addr_oath');
$webroot = $globals->getWebRoot();
$fhirBaseUrl = $siteAddr . $webroot . '/apis/' . $siteId . '/fhir';
// Resolve the JWT issuer through the shared helper so this entry point
// agrees byte-for-byte with the verifier side. Composing
// `site_addr_oath + webroot + /oauth2/{site}` directly produces the
// container's self-URL (e.g. http://localhost:8300), which mismatches
// the agent's AGENT_JWT_ISSUER on any deploy where the browser-facing
// URL differs (https://localhost:9300 in dev, https://emr.biograph.dev
// in prod). The helper honors OE_AGENT_JWT_ISSUER for that pinning.
$issuer = AgentEndpointBootstrap::resolveIssuer($siteId);

$resolvedFhirUser = null;
if ($authUserId !== '') {
    try {
        $resolvedFhirUser = (new FhirUserResolver())->resolve($authUserId, $fhirBaseUrl);
    } catch (FhirUserResolutionException) {
        $resolvedFhirUser = null;
    }
}

$agentBaseUrlEnv = getenv('AGENT_SERVICE_URL');
$agentBaseUrl = is_string($agentBaseUrlEnv) && $agentBaseUrlEnv !== ''
    ? $agentBaseUrlEnv
    : 'http://agent:8080';

$controller = ExtractController::fromEnvironment($agentBaseUrl, $issuer);
$controller->handle(
    rawBody: $request->getContent(),
    authUserId: $authUserId,
    authUser: $authUser,
    siteId: $siteId,
    sessionPid: $sessionPid,
    fhirUser: $resolvedFhirUser,
);
