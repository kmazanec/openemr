<?php

/**
 * Narrow agent endpoint: provenance for a single prescription.
 *
 * 1:1 with the agent's `getPrescriptionProvenance` tool. Backs the §4.3
 * UC3 prescription-change drill-down — returns the prescribing date,
 * prescriber, indication, and dose for one prescription.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/prescription_provenance.php
 *       ?pid=<pid>&site=<id>&prescriptionId=<int>&conversation=<id?>
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

// Tell globals.php to skip its auth.inc.php redirect — bearer auth, not session.
$ignoreAuth = true; // phpcs:ignore SlevomatCodingStandard.Variables.UnusedVariable -- read by globals.php
require_once __DIR__ . '/../../../../../globals.php';

use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\SqlAgentActorResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\SystemClock;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap\AgentEndpointBootstrap;
use OpenEMR\Modules\ClinicalCopilot\Controller\PrescriptionProvenanceController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionProvenanceAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\PrescriptionProvenanceServiceDataSource;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$prescriptionIdParam = $request->query->get('prescriptionId');
$prescriptionId = (is_string($prescriptionIdParam) && ctype_digit($prescriptionIdParam))
    ? (int) $prescriptionIdParam
    : null;

$controller = new PrescriptionProvenanceController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    adapter: new PrescriptionProvenanceAdapter(new PrescriptionProvenanceServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle($parsed->bearer, $parsed->pid, $prescriptionId, $parsed->conversationId);
