<?php

/**
 * Clinical Co-Pilot side-by-side viewer document download.
 *
 * UUID-keyed proxy in front of OpenEMR's existing `Document::get_data()`
 * machinery. The panel's `documentViewer.js` fetches this endpoint when
 * an extracted-document chip is clicked; the response carries the raw
 * document bytes (PDF/PNG/JPEG) with the document's recorded MIME, or —
 * for `image/tiff` inputs — decoded `image/png` bytes via
 * {@see DocumentViewResponder} (F.4b).
 *
 * Routing:
 *   GET /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/document_view.php?document_uuid=<UUID>
 *
 * Auth: the existing OpenEMR session — the panel runs in the same chrome
 * as the rest of the chart, no new auth surface. ACL check is the same
 * patients/med gate the panel page itself enforces; foreign-id (patient
 * pid) is verified against the active session pid so a clinician with
 * access to chart A can't fetch a document attached to chart B by
 * URL-mangling.
 *
 * Architecture: HTTP concerns (globals, ACL, headers, body emission)
 * stay in this shim. The branch logic — null document, mismatched pid,
 * empty bytes, TIFF decode — is delegated to
 * {@see DocumentViewResponder} so it's unit-testable without a session
 * or `\Imagick` on the host.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../../../globals.php';

use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView\DocumentViewResponder;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView\ImagickTiffDecoder;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView\ResolvedDocument;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$session = SessionWrapperFactory::getInstance()->getActiveSession();

if (!AclMain::aclCheckCore('patients', 'med')) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'forbidden']);
    return;
}

$documentUuid = $request->query->get('document_uuid');
if (!is_string($documentUuid) || $documentUuid === '') {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'missing_document_uuid']);
    return;
}

$resolved = null;
$document = Document::getDocumentForUuid($documentUuid);
// Document::getDocumentForUuid returns Document|null per its source; the
// declared return type is `mixed` for legacy reasons. Narrow with
// `instanceof` so the rest of the file is type-safe without a cast.
if ($document instanceof Document) {
    $foreignIdRaw = $document->get_foreign_id();
    $documentPid = is_scalar($foreignIdRaw) ? (int) $foreignIdRaw : 0;
    $mimeRaw = $document->get_mimetype();
    $mimeType = is_string($mimeRaw) ? $mimeRaw : '';
    // Document::get_data throws BadMethodCallException for expired/deleted
    // documents (see library/classes/Document.class.php). Treat that as a
    // resolved-but-unavailable document — same shape as bytes-empty so
    // the responder returns a 404 envelope, not a 500.
    try {
        $bytes = $document->get_data();
    } catch (BadMethodCallException) {
        $bytes = '';
    }
    $resolved = new ResolvedDocument(
        foreignId: $documentPid,
        mimeType: $mimeType,
        bytes: is_string($bytes) ? $bytes : '',
    );
}

$sessionPidRaw = $session->get('pid');
$sessionPid = is_scalar($sessionPidRaw) ? (int) $sessionPidRaw : 0;

$responder = new DocumentViewResponder(new ImagickTiffDecoder());
$response = $responder->respond($resolved, $sessionPid);

http_response_code($response->statusCode);
header('Content-Type: ' . $response->contentType);
header('Content-Length: ' . strlen((string) $response->body));
header('X-Content-Type-Options: nosniff');
if ($response->statusCode === 200) {
    // 5-min cache so a chip swap that re-clicks an already-rendered chip
    // doesn't re-download the document. Session-scoped ACL above makes
    // this safe; the document's bytes can't be served to a clinician
    // who isn't already authorized to see them.
    header('Cache-Control: private, max-age=300');
}
echo $response->body;
