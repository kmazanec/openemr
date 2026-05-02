<?php

/**
 * Narrow agent endpoint: lab history for a single analyte.
 *
 * 1:1 with the agent's `getLabHistory` tool. Runs only the
 * ObservationAdapter's history-by-analyte path.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/lab-history.php
 *       ?pid=<pid>&site=<id>&analyte=<name>&lookback_days=<int>
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
use OpenEMR\Modules\ClinicalCopilot\Controller\LabHistoryController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ObservationServiceDataSource;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$analyteRaw = $request->query->get('analyte');
$analyte = is_string($analyteRaw) && $analyteRaw !== '' ? $analyteRaw : null;

$lookbackRaw = $request->query->get('lookback_days');
$lookbackDays = is_string($lookbackRaw) && ctype_digit($lookbackRaw) ? (int) $lookbackRaw : null;

$controller = new LabHistoryController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    observationAdapter: new ObservationAdapter(new ObservationServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle(
    $parsed->bearer,
    $parsed->pid,
    $parsed->conversationId,
    $analyte,
    $lookbackDays,
);
