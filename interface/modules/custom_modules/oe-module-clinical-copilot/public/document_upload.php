<?php

/**
 * §D.1 panel upload endpoint: browser POST that stores canonical
 * document bytes in DigitalOcean Spaces *and* on local disk under
 * `OE_SITE_DIR/documents/<pid>/`, pre-writes the `documents` row so
 * the legacy Documents-tab viewer can render the upload immediately,
 * and returns a freshly minted `document_uuid` so the panel can
 * attach it to the next supervisor turn.
 *
 * This entry point uses the **proxy** pattern (session-based auth,
 * server-side Spaces credential) and lives next to `agent.php` and
 * `extract.php`. The bearer-token pattern that `snapshot/*.php`
 * endpoints use is for agent-inbound traffic (the agent calling back
 * to OpenEMR with a JWT it already holds); the upload goes the other
 * direction — browser → OpenEMR → Spaces — so it belongs alongside
 * the other browser-inbound entries, not under `snapshot/`.
 *
 * Request shape:
 *   POST /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/document_upload.php
 *   Body: multipart/form-data with `file`
 *   Headers: same OpenEMR session cookie as the panel page
 *   ACL: patients/med (mirrors panel.php)
 *
 * Response:
 *   200 { document_uuid, doc_type_guess, spaces_url }
 *   400/401/403/413/415/503 { error: <code> }
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../../../globals.php';

use OpenEMR\BC\ServiceContainer;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Auth\SystemClock;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap\AgentEndpointBootstrap;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentUploadController;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDbalConnection;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentReferenceWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\Production\DbalDocumentTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\Production\FilesystemLocalDocumentStore;
use OpenEMR\Modules\ClinicalCopilot\Service\Production\SigV4SpacesUploadService;
use OpenEMR\Modules\ClinicalCopilot\Service\SpacesConfig;
use OpenEMR\Modules\ClinicalCopilot\Service\UuidRegistryDocumentUuidGenerator;
use Symfony\Component\HttpFoundation\Request;

if (!AclMain::aclCheckCore('patients', 'med')) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'acl_denied'], JSON_THROW_ON_ERROR);
    return;
}

$request = Request::createFromGlobals();
$session = SessionWrapperFactory::getInstance()->getActiveSession();

$sessionPidRaw = $session->get('pid');
$sessionPid = is_scalar($sessionPidRaw) ? (int) $sessionPidRaw : 0;
if ($sessionPid <= 0) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'missing_pid'], JSON_THROW_ON_ERROR);
    return;
}

$uploaded = $request->files->get('file');
if (!$uploaded instanceof \Symfony\Component\HttpFoundation\File\UploadedFile || !$uploaded->isValid()) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'missing_file'], JSON_THROW_ON_ERROR);
    return;
}

$tmpPath = $uploaded->getRealPath();
if ($tmpPath === false) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'missing_file'], JSON_THROW_ON_ERROR);
    return;
}

$bytes = file_get_contents($tmpPath);
if ($bytes === false) {
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'upload_unavailable'], JSON_THROW_ON_ERROR);
    return;
}

$detectedMime = null;
if (function_exists('finfo_open')) {
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    if ($finfo !== false) {
        $sniffed = finfo_buffer($finfo, $bytes);
        finfo_close($finfo);
        if (is_string($sniffed) && $sniffed !== '') {
            $detectedMime = $sniffed;
        }
    }
}

$logger = ServiceContainer::getLogger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$globals = OEGlobalsBag::getInstance();
$siteDir = $globals->getString('OE_SITE_DIR');
if ($siteDir === '') {
    $logger->error('Document upload missing OE_SITE_DIR — refusing to persist locally');
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'persist_unavailable'], JSON_THROW_ON_ERROR);
    return;
}

$writeService = new DocumentReferenceWriteService(
    tableWriter: new DbalDocumentTableWriter(AgentDbalConnection::get()),
    uuidGenerator: new UuidRegistryDocumentUuidGenerator(),
    eventDispatcher: $dispatcher,
    clock: new SystemClock(),
    logger: $logger,
);

$controller = new DocumentUploadController(
    uploadService: new SigV4SpacesUploadService(
        config: SpacesConfig::fromEnv(getenv()),
        httpClient: new \GuzzleHttp\Client(),
        clock: new SystemClock(),
        logger: $logger,
    ),
    localStore: new FilesystemLocalDocumentStore($siteDir . '/documents'),
    writeService: $writeService,
    uuidGenerator: new UuidRegistryDocumentUuidGenerator(),
    logger: $logger,
);

$controller->handle(
    pid: $sessionPid,
    originalFilename: $uploaded->getClientOriginalName(),
    detectedMime: $detectedMime,
    bytes: $bytes,
);
