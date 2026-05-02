<?php

/**
 * Narrow agent endpoint: provenance for a single prescription.
 *
 * 1:1 with the agent's `getMedicationProvenance` tool. Backs the §4.3
 * UC3 medication-change drill-down — returns the prescribing date,
 * prescriber, indication, and dose for one prescription.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/medication_provenance.php
 *       ?pid=<pid>&site=<id>&medicationId=<int>&conversation=<id?>
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
use OpenEMR\Modules\ClinicalCopilot\Controller\MedicationProvenanceController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationProvenanceAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\MedicationProvenanceServiceDataSource;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$medicationIdParam = $request->query->get('medicationId');
$medicationId = (is_string($medicationIdParam) && ctype_digit($medicationIdParam))
    ? (int) $medicationIdParam
    : null;

$controller = new MedicationProvenanceController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    adapter: new MedicationProvenanceAdapter(new MedicationProvenanceServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle($parsed->bearer, $parsed->pid, $medicationId, $parsed->conversationId);
