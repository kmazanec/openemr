<?php

/**
 * Narrow agent endpoint: demographics + active diagnoses + active
 * allergies — the "who is this patient" bundle.
 *
 * 1:1 with the agent's `getPatientContext` tool. Runs only patient,
 * condition, and allergy adapters. Bundling these three is a
 * deliberate exception to the per-category split; see the controller
 * docblock for the rationale.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/patientContext.php?pid=<pid>&site=<id>&conversation=<id?>
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

$ignoreAuth = true; // phpcs:ignore SlevomatCodingStandard.Variables.UnusedVariable -- read by globals.php
require_once __DIR__ . '/../../../../../globals.php';

use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\SqlAgentActorResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\SystemClock;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap\AgentEndpointBootstrap;
use OpenEMR\Modules\ClinicalCopilot\Controller\PatientContextController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\AllergyServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ConditionServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\PatientServiceDataSource;
use Symfony\Component\HttpFoundation\Request;

$parsed = AgentEndpointBootstrap::parseRequest(Request::createFromGlobals());
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$controller = new PatientContextController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    patientAdapter: new PatientAdapter(new PatientServiceDataSource()),
    conditionAdapter: new ConditionAdapter(new ConditionServiceDataSource()),
    allergyAdapter: new AllergyAdapter(new AllergyServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle($parsed->bearer, $parsed->pid, $parsed->conversationId);
