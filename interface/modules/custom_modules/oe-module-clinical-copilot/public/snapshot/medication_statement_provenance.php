<?php

/**
 * Narrow agent endpoint: provenance for a single patient-reported
 * medication entry (FHIR `MedicationStatement`).
 *
 * 1:1 with the agent's `getMedicationStatementProvenance` tool.
 * Backs §4.6.6's medication-statement-detail drill-down.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/medication_statement_provenance.php
 *       ?pid=<pid>&site=<id>&listId=<int>&conversation=<id?>
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
use OpenEMR\Modules\ClinicalCopilot\Controller\MedicationStatementProvenanceController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationStatementProvenanceAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\MedicationStatementProvenanceServiceDataSource;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$listIdParam = $request->query->get('listId');
$listId = (is_string($listIdParam) && ctype_digit($listIdParam))
    ? (int) $listIdParam
    : null;

$controller = new MedicationStatementProvenanceController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    adapter: new MedicationStatementProvenanceAdapter(
        new MedicationStatementProvenanceServiceDataSource(),
    ),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle($parsed->bearer, $parsed->pid, $listId, $parsed->conversationId);
