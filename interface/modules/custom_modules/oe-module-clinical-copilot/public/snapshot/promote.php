<?php

/**
 * Tier-3 endpoint: agent-callback POST that promotes an extracted
 * fact to a real chart record. Dispatches on `?type=` to the
 * per-fact-type handler in {@see PromoteController}.
 *
 * Request shape:
 *   POST /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/promote.php?type=<type>&site=<id>[&conversation=<id>]
 *   Body (JSON): per-type payload — see PromoteController.
 *   Headers: Authorization: Bearer <agent JWT>
 *   Required scope: per-type — `user/DiagnosticReport.cs` for `lab`.
 *
 * Response (lab type):
 *   200 { chart_record_uuid, chart_record_type, observation_uuids, idempotent_hit }
 *   400/401/403/501/503 { error: <code> }
 *
 * Lives next to the read-shaped `snapshot/*.php` endpoints because it
 * is part of the same agent-inbound JWT-bearer surface, even though
 * the operation is a chart write rather than a snapshot read. The
 * `snapshot/` directory groups by auth model, not by HTTP semantics.
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
use OpenEMR\Modules\ClinicalCopilot\Controller\PromoteController;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDbalConnection;
use OpenEMR\Modules\ClinicalCopilot\Service\AllergyListWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\ObservationLabWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\Production\DbalAllergyListsTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\Production\DbalProcedureReportTableWriter;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$typeParam = $request->query->get('type');
$type = is_string($typeParam) && $typeParam !== '' ? $typeParam : null;

$rawBody = $request->getContent();
$decodedBody = null;
if ($rawBody !== '') {
    $decoded = json_decode($rawBody, associative: true);
    if (is_array($decoded)) {
        $stringKeyed = [];
        foreach ($decoded as $key => $value) {
            if (is_string($key)) {
                $stringKeyed[$key] = $value;
            }
        }
        $decodedBody = $stringKeyed;
    }
}

$connection = AgentDbalConnection::get();
$clock = new SystemClock();

$labWriteService = new ObservationLabWriteService(
    tableWriter: new DbalProcedureReportTableWriter($connection),
    eventDispatcher: $dispatcher,
    clock: $clock,
    logger: $logger,
);

$allergyWriteService = new AllergyListWriteService(
    tableWriter: new DbalAllergyListsTableWriter($connection),
    eventDispatcher: $dispatcher,
    clock: $clock,
    logger: $logger,
);

$controller = new PromoteController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    labWriteService: $labWriteService,
    allergyWriteService: $allergyWriteService,
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: $clock,
);

$controller->dispatch($parsed->bearer, $type, $decodedBody, $parsed->conversationId);
