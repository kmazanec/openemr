<?php

/**
 * Clinical Co-Pilot side-by-side viewer document download.
 *
 * UUID-keyed proxy in front of OpenEMR's existing `Document::get_data()`
 * machinery. The panel's `documentViewer.js` fetches this endpoint when
 * an extracted-document chip is clicked; the response carries the raw
 * document bytes with the document's recorded MIME so the viewer can
 * branch (PDF.js / `<img>` / TIFF placeholder).
 *
 * Routing:
 *   GET /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/document_view.php?document_uuid=<UUID>[&page=<N>]
 *
 * Auth: the existing OpenEMR session — the panel runs in the same chrome
 * as the rest of the chart, no new auth surface. ACL check is the same
 * patients/med gate the panel page itself enforces; foreign-id (patient
 * pid) is verified against the active session pid so a clinician with
 * access to chart A can't fetch a document attached to chart B by
 * URL-mangling.
 *
 * `page` is accepted for forward compatibility (future multi-page TIFF
 * decode in F.4b will key on it) but ignored here — the bytes returned
 * are the full document; the viewer takes care of page-level rendering.
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

$document = Document::getDocumentForUuid($documentUuid);
// Document::getDocumentForUuid returns Document|null per its source; the
// declared return type is `mixed` for legacy reasons. Narrow with
// `instanceof` so the rest of the file is type-safe without a cast.
if (!$document instanceof Document) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'document_not_found']);
    return;
}

// Cross-chart lookup defense: confirm the document's patient (foreign_id)
// matches the active session pid. Documents not attached to a patient
// (foreign_id 0) are not in scope for this endpoint — the panel only
// renders chart-attached documents.
$foreignIdRaw = $document->get_foreign_id();
$documentPid = is_scalar($foreignIdRaw) ? (int) $foreignIdRaw : 0;
$sessionPidRaw = $session->get('pid');
$sessionPid = is_scalar($sessionPidRaw) ? (int) $sessionPidRaw : 0;
if ($documentPid <= 0 || $documentPid !== $sessionPid) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'patient_scope_mismatch']);
    return;
}

$mimeRaw = $document->get_mimetype();
$mimeType = (is_string($mimeRaw) && $mimeRaw !== '') ? $mimeRaw : 'application/octet-stream';

// Document::get_data throws BadMethodCallException for expired/deleted
// documents (see library/classes/Document.class.php). Narrow the catch
// to that — filesystem/decryption RuntimeExceptions and unexpected
// Errors propagate to the global handler, which is the right behavior
// for a 500-class failure path the panel can't recover from anyway.
try {
    $data = $document->get_data();
} catch (BadMethodCallException) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'document_unavailable']);
    return;
}

if (!is_string($data) || $data === '') {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'document_empty']);
    return;
}

header('Content-Type: ' . $mimeType);
header('Content-Length: ' . strlen($data));
header('X-Content-Type-Options: nosniff');
// 5-min cache so a chip swap that re-clicks an already-rendered chip
// doesn't re-download the full PDF. The session-scoped ACL gate above
// makes this safe; the document's bytes can't be served to a clinician
// who isn't already authorized to see them.
header('Cache-Control: private, max-age=300');
echo $data;
