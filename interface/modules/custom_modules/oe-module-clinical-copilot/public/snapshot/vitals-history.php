<?php

/**
 * Narrow agent endpoint: vitals history for a single vital type.
 *
 * 1:1 with the agent's `getVitalsHistory` tool. Runs only the
 * VitalsAdapter's history-by-vital-type path.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/vitals-history.php
 *       ?pid=<pid>&site=<id>&vital_type=<token>&lookback_days=<int>
 *       [&conversation=<id>]
 *
 * Allowed `vital_type` tokens: see VitalsAdapter::VITAL_TYPES.
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
use OpenEMR\Modules\ClinicalCopilot\Controller\VitalsHistoryController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\VitalsServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\VitalsAdapter;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$vitalTypeRaw = $request->query->get('vital_type');
$vitalType = is_string($vitalTypeRaw) && $vitalTypeRaw !== '' ? $vitalTypeRaw : null;

$lookbackRaw = $request->query->get('lookback_days');
$lookbackDays = is_string($lookbackRaw) && ctype_digit($lookbackRaw) ? (int) $lookbackRaw : null;

$controller = new VitalsHistoryController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    vitalsAdapter: new VitalsAdapter(new VitalsServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle(
    $parsed->bearer,
    $parsed->pid,
    $parsed->conversationId,
    $vitalType,
    $lookbackDays,
);
