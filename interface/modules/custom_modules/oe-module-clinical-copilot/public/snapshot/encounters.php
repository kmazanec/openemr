<?php

/**
 * Narrow agent endpoint: recent encounters only.
 *
 * 1:1 with the agent's `getRecentEncounters` tool. Runs both
 * EncounterAdapter (native `form_encounter`) and
 * ExternalEncounterAdapter (CCDA-imported `external_encounters`); the
 * merged list distinguishes the two via `source.system`.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/encounters.php?pid=<pid>&site=<id>&conversation=<id?>
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
use OpenEMR\Modules\ClinicalCopilot\Controller\EncountersController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ExternalEncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\EncounterServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ExternalEncounterServiceDataSource;
use Symfony\Component\HttpFoundation\Request;

$parsed = AgentEndpointBootstrap::parseRequest(Request::createFromGlobals());
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$controller = new EncountersController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    encounterAdapter: new EncounterAdapter(new EncounterServiceDataSource()),
    externalEncounterAdapter: new ExternalEncounterAdapter(new ExternalEncounterServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle($parsed->bearer, $parsed->pid, $parsed->conversationId);
