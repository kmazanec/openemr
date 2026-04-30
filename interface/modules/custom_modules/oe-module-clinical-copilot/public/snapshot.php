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

require_once __DIR__ . '/../../../../globals.php';

use OpenEMR\BC\ServiceContainer;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\SqlAgentActorResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\SystemClock;
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\AllergyServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\AppointmentServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ConditionServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\EncounterServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\MedicationServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ObservationServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\PatientServiceDataSource;
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

// Issuer derivation matches AgentProxyController exactly: the minter
// stamps `site_addr_oath + webroot + /oauth2/{site}` so the verifier
// has to compose the same string.
$siteAddr = $globals->getString('site_addr_oath');
$webroot = $globals->getWebRoot();
$issuer = $siteAddr . $webroot . '/oauth2/' . $siteId;

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
    medicationAdapter: new MedicationAdapter(new MedicationServiceDataSource()),
    allergyAdapter: new AllergyAdapter(new AllergyServiceDataSource()),
    observationAdapter: new ObservationAdapter(new ObservationServiceDataSource()),
    encounterAdapter: new EncounterAdapter(new EncounterServiceDataSource()),
    appointmentAdapter: new AppointmentAdapter(new AppointmentServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $siteId,
    clock: new SystemClock(),
);

$controller->handle($bearer, $pid, $categories, $conversationId);
