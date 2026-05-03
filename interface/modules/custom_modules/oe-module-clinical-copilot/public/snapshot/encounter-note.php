<?php

/**
 * Narrow agent endpoint: SOAP note(s) for a single encounter.
 *
 * 1:1 with the agent's `getEncounterNote` tool.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/encounter-note.php
 *       ?pid=<pid>&site=<id>&encounter_id=<int>
 *       [&conversation=<id>]
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
use OpenEMR\Modules\ClinicalCopilot\Controller\EncounterNoteController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterNoteAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\EncounterNoteServiceDataSource;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$encounterIdRaw = $request->query->get('encounter_id');
$encounterId = is_string($encounterIdRaw) && ctype_digit($encounterIdRaw) ? (int) $encounterIdRaw : null;

$controller = new EncounterNoteController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    encounterNoteAdapter: new EncounterNoteAdapter(new EncounterNoteServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle(
    $parsed->bearer,
    $parsed->pid,
    $parsed->conversationId,
    $encounterId,
);
