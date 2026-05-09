<?php

/**
 * Agent-callback snapshot endpoint.
 *
 * Caller is the **Node agent** presenting the JWT it received from
 * `AgentTokenMinter`. The browser never hits this URL; the OpenEMR
 * session is not used for auth — the bearer token is the trust
 * anchor.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot.php?pid=<pid>&categories=<csv>&conversation=<id?>
 *
 * Why globals.php is still loaded: we need OpenEMR's site config
 * resolution (sites/$siteId/sqlconf.php, oauth2 key paths, webroot) to
 * derive the same issuer the minter stamped and to read the public
 * key. The session it boots is unused — auth is the JWT.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

// TODO(§6.x — production hardening): migrate this endpoint under /apis/
// where every other bearer-authenticated surface in OpenEMR already
// lives. Today snapshot.php sits beside agent.php (a browser entry
// using a session cookie) but uses a different trust model (server-to-
// server bearer JWT). That mix is why we have to set $ignoreAuth here
// AND ship a sibling .htaccess to preserve the Authorization header —
// mod_php strips it from $_SERVER before PHP sees it, and the existing
// apis/.htaccess already applies the same workaround there. Moving
// snapshot.php under /apis (or behind a thin dispatch.php routing rule)
// would inherit the existing .htaccess, the rate-limit middleware, and
// the audit trail that wraps the FHIR/REST surface. Tracked alongside
// the §6.3 production-readiness checklist.
//
// Tell globals.php to skip its auth.inc.php redirect — this endpoint is
// authenticated by the bearer token, not a session cookie. The agent
// service has no OpenEMR session of its own; the JWT verifier below is
// the only trust anchor. Without this flag, globals.php sees no session
// and serves the HTML login page instead of letting our handler run.
$ignoreAuth = true; // phpcs:ignore SlevomatCodingStandard.Variables.UnusedVariable -- read by globals.php
require_once __DIR__ . '/../../../../globals.php';

use OpenEMR\BC\ServiceContainer;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\SqlAgentActorResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\SystemClock;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap\AgentEndpointBootstrap;
use OpenEMR\Modules\ClinicalCopilot\Controller\AgentSnapshotController;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDbalConnection;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\DbalAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\ExtendedLogDisclosureRecorder;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AppointmentAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ExternalEncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationStatementAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\AllergyServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\AppointmentServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ConditionServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\EncounterServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ExternalEncounterServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\MedicationStatementServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ObservationServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\PatientServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\PrescriptionServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ReminderServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ReminderAdapter;
use Symfony\Component\EventDispatcher\EventDispatcher;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$globals = OEGlobalsBag::getInstance();

$bearer = null;
$authHeader = $request->headers->get('Authorization');
if (is_string($authHeader) && str_starts_with($authHeader, 'Bearer ')) {
    $bearer = substr($authHeader, 7);
}

$pid = null;
$pidParam = $request->query->get('pid');
if (is_string($pidParam) && ctype_digit($pidParam)) {
    $pid = (int) $pidParam;
}

$categoriesParam = $request->query->get('categories');
$categories = null;
if (is_string($categoriesParam) && $categoriesParam !== '') {
    $categories = array_values(array_filter(
        array_map(trim(...), explode(',', $categoriesParam)),
        static fn(string $s): bool => $s !== '',
    ));
}

$conversationParam = $request->query->get('conversation');
$conversationId = is_string($conversationParam) && $conversationParam !== ''
    ? $conversationParam
    : null;

$siteIdRaw = $request->query->get('site');
$siteId = is_string($siteIdRaw) && $siteIdRaw !== '' ? $siteIdRaw : 'default';

// Resolve the JWT issuer through the shared helper so the verifier
// and the minter (in agent.php) compose the exact same string. The
// helper honors OE_AGENT_JWT_ISSUER when set; otherwise it falls
// back to `site_addr_oath + webroot + /oauth2/{site}`. See the
// rationale on `AgentEndpointBootstrap::resolveIssuer`.
$issuer = AgentEndpointBootstrap::resolveIssuer($siteId);

$connection = AgentDbalConnection::get();
$logger = ServiceContainer::getLogger();

$dispatcher = new EventDispatcher();
$dispatcher->addListener(
    AgentDisclosedEvent::EVENT_HANDLE,
    new AgentDisclosureListener(
        new ExtendedLogDisclosureRecorder($connection),
        new DbalAgentRequestLogRecorder($connection),
        $logger,
    ),
);

$controller = new AgentSnapshotController(
    verifier: new OpenEmrJwtVerifier(
        publicKeyPem: AgentSigningKey::fromOAuth2KeyConfig()->publicKeyPem,
        issuer: $issuer,
        audience: AgentTokenMinter::AGENT_CLIENT_ID,
    ),
    actorResolver: new SqlAgentActorResolver(),
    patientAdapter: new PatientAdapter(new PatientServiceDataSource()),
    conditionAdapter: new ConditionAdapter(new ConditionServiceDataSource()),
    prescriptionAdapter: new PrescriptionAdapter(new PrescriptionServiceDataSource()),
    allergyAdapter: new AllergyAdapter(new AllergyServiceDataSource()),
    observationAdapter: new ObservationAdapter(new ObservationServiceDataSource()),
    encounterAdapter: new EncounterAdapter(new EncounterServiceDataSource()),
    externalEncounterAdapter: new ExternalEncounterAdapter(new ExternalEncounterServiceDataSource()),
    appointmentAdapter: new AppointmentAdapter(new AppointmentServiceDataSource()),
    reminderAdapter: new ReminderAdapter(new ReminderServiceDataSource()),
    medicationStatementAdapter: new MedicationStatementAdapter(new MedicationStatementServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $siteId,
    clock: new SystemClock(),
);

$controller->handle($bearer, $pid, $categories, $conversationId);
