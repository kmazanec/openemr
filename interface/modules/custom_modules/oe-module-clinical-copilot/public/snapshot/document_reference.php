<?php

/**
 * Tier-1 endpoint: agent-callback POST that records a DocumentReference
 * for canonical document bytes already uploaded to DigitalOcean Spaces.
 *
 * Request shape:
 *   POST /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/document_reference.php?site=<id>[&conversation=<id>]
 *   Body (JSON): { pid, doc_type, spaces_url, mime_type, filename }
 *   Headers: Authorization: Bearer <agent JWT>
 *   Required scope: user/DocumentReference.cs
 *
 * Response:
 *   200 { document_uuid }
 *   400/401/403/503 { error: <code> }
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
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentReferenceController;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDbalConnection;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentReferenceWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\Production\DbalDocumentTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\UuidRegistryDocumentUuidGenerator;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$rawBody = $request->getContent();
$decodedBody = null;
if ($rawBody !== '') {
    $decoded = json_decode($rawBody, associative: true);
    if (is_array($decoded)) {
        // Coerce to a string-keyed array for the controller's contract.
        $stringKeyed = [];
        foreach ($decoded as $key => $value) {
            if (is_string($key)) {
                $stringKeyed[$key] = $value;
            }
        }
        $decodedBody = $stringKeyed;
    }
}

$writeService = new DocumentReferenceWriteService(
    tableWriter: new DbalDocumentTableWriter(AgentDbalConnection::get()),
    uuidGenerator: new UuidRegistryDocumentUuidGenerator(),
    eventDispatcher: $dispatcher,
    clock: new SystemClock(),
    logger: $logger,
);

$controller = new DocumentReferenceController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    writeService: $writeService,
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle($parsed->bearer, $decodedBody, $parsed->conversationId);
