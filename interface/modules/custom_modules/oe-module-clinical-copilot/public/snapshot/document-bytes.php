<?php

/**
 * Narrow agent endpoint: streams the raw bytes of a
 * Clinical-Copilot-categorized chart document by uuid. Used as a
 * fallback by the agent's rasterizer when the canonical Spaces
 * lookup misses (legacy-UI uploads land on local disk, not in the
 * Spaces bucket).
 *
 * 1:1 with the agent's rasterize-node fallback fetch.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/document-bytes.php?pid=<pid>&uuid=<uuid>&site=<id>&conversation=<id?>
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

use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\SqlAgentActorResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\SystemClock;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap\AgentEndpointBootstrap;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentBytesController;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$globals = OEGlobalsBag::getInstance();
$siteDir = $globals->getString('OE_SITE_DIR');
if ($siteDir === '') {
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'snapshot_unavailable'], JSON_THROW_ON_ERROR);
    return;
}

$documentUuidRaw = $request->query->get('uuid');
$documentUuid = is_string($documentUuidRaw) && $documentUuidRaw !== '' ? $documentUuidRaw : null;

$controller = new DocumentBytesController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
    siteDocumentsRoot: rtrim($siteDir, '/') . '/documents',
);

$controller->handle($parsed->bearer, $parsed->pid, $documentUuid, $parsed->conversationId);
