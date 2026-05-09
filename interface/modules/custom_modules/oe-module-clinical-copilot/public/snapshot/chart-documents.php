<?php

/**
 * Narrow agent endpoint: lists Clinical-Copilot-categorized chart
 * documents for a patient (regardless of extraction state). The
 * agent filters on its own DB to drop already-processed documents
 * before injecting the rest into a follow-up briefing's
 * `pendingUploads`, so the supervisor's existing
 * `kickoffExtraction` path runs unchanged for chart-side uploads.
 *
 * 1:1 with the agent's `getChartDocuments` tool.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/chart-documents.php?pid=<pid>&site=<id>&conversation=<id?>
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
use OpenEMR\Modules\ClinicalCopilot\Controller\ChartDocumentsController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ChartDocumentsDataSource;
use Symfony\Component\HttpFoundation\Request;

$parsed = AgentEndpointBootstrap::parseRequest(Request::createFromGlobals());
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$controller = new ChartDocumentsController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    dataSource: new ChartDocumentsDataSource(),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle($parsed->bearer, $parsed->pid, $parsed->conversationId);
