<?php

/**
 * Streams the raw bytes of a Clinical-Copilot-categorized chart
 * document by uuid. Used by the agent's rasterizer as a fallback
 * when the canonical Spaces lookup misses (which happens for
 * documents uploaded through OpenEMR's legacy Documents UI — those
 * land on the local filesystem, not in the Spaces bucket the
 * pipeline normally reads from).
 *
 * Restricted to Clinical-Copilot-categorized rows so a leaked token
 * cannot use this endpoint as a generic chart-document reader. The
 * scope `user/DocumentReference.rs` is already required by
 * `chart-documents.php`; reusing it keeps the briefing PolicyGate
 * entry small.
 *
 * Maps 1:1 to `public/snapshot/document-bytes.php`.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller;

use OpenEMR\BC\ServiceContainer;
use OpenEMR\Common\Crypto\KeySource;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class DocumentBytesController
{
    private const ROOT_CATEGORY_NAME = 'Clinical Copilot';
    private const UUID_PATTERN = '/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/';

    public function __construct(
        private AgentEndpointAuth $auth,
        private EventDispatcherInterface $eventDispatcher,
        private LoggerInterface $logger,
        private string $siteId,
        private ClockInterface $clock,
        private string $siteDocumentsRoot,
    ) {
    }

    public function handle(
        ?string $bearerToken,
        ?int $pid,
        ?string $documentUuid,
        ?string $conversationId,
    ): void {
        $request = $this->auth->authorize($bearerToken, 'user/DocumentReference.rs');
        if ($request === null) {
            return;
        }

        if ($pid === null || $pid <= 0) {
            $this->respondError(400, 'missing_pid');
            return;
        }

        if ($documentUuid === null || preg_match(self::UUID_PATTERN, $documentUuid) !== 1) {
            $this->respondError(400, 'invalid_uuid');
            return;
        }

        $hex = str_replace('-', '', $documentUuid);
        $binary = hex2bin($hex);
        if ($binary === false || strlen($binary) !== 16) {
            $this->respondError(400, 'invalid_uuid');
            return;
        }

        try {
            $row = $this->lookupDocument($pid, $binary);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent document-bytes lookup failed', [
                'pid' => $pid,
                'documentUuid' => $documentUuid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'snapshot_unavailable');
            return;
        }

        if ($row === null) {
            // Either the document does not exist, is deleted,
            // belongs to a different patient, or is not under the
            // Clinical Copilot category root. Collapse all four into
            // a single response so a probe can't enumerate.
            $this->respondError(404, 'not_found');
            return;
        }

        $absolutePath = $this->resolveFilesystemPath($row['url']);
        if ($absolutePath === null) {
            $this->logger->warning('Agent document-bytes: unsupported url scheme or path traversal', [
                'pid' => $pid,
                'documentUuid' => $documentUuid,
                'url' => $row['url'],
            ]);
            $this->respondError(404, 'not_found');
            return;
        }

        if (!is_file($absolutePath) || !is_readable($absolutePath)) {
            $this->logger->warning('Agent document-bytes: file missing or unreadable on disk', [
                'pid' => $pid,
                'documentUuid' => $documentUuid,
                'absolutePath' => $absolutePath,
            ]);
            $this->respondError(404, 'not_found');
            return;
        }

        $bytes = @file_get_contents($absolutePath);
        if ($bytes === false) {
            $this->logger->error('Agent document-bytes: file_get_contents failed', [
                'pid' => $pid,
                'documentUuid' => $documentUuid,
                'absolutePath' => $absolutePath,
            ]);
            $this->respondError(503, 'storage_unreachable');
            return;
        }

        if ($row['encrypted']) {
            // Legacy Documents UI uploads with at-rest encryption
            // enabled. Without decrypting here, the agent's vision
            // call sees ciphertext and rejects with "invalid file
            // format." Mirror Document::decrypt_content so the
            // returned bytes are byte-equivalent to what the
            // Documents tab would render.
            $plain = $this->decryptBytes($bytes);
            if ($plain === null) {
                $this->respondError(503, 'storage_unreachable');
                return;
            }
            $bytes = $plain;
        }

        $now = $this->clock->now();
        try {
            $this->eventDispatcher->dispatch(
                new AgentDisclosedEvent(new AgentDisclosure(
                    disclosedAt: $now,
                    actorUserId: $request->actor->userId,
                    actorFhirUser: $request->verified->fhirUser,
                    siteId: $this->siteId,
                    patientPid: $pid,
                    patientUuid: null,
                    conversationId: $conversationId,
                    action: 'document_bytes',
                    requestId: $request->verified->jti,
                    categories: ['document_reference'],
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            // Disclosure write is best-effort; the bytes are still
            // safe to ship. Log loudly so an operator can replay
            // disclosure from agent_request_log if needed.
            $this->logger->error('Agent document-bytes disclosure write failed', [
                'pid' => $pid,
                'documentUuid' => $documentUuid,
                'exception' => $e,
            ]);
        }

        $mimetype = $row['mimetype'] !== '' ? $row['mimetype'] : 'application/octet-stream';
        if (!headers_sent()) {
            http_response_code(200);
            header('Content-Type: ' . $mimetype);
            header('Content-Length: ' . strlen($bytes));
        }
        echo $bytes;
    }

    /**
     * Look up a document by `pid + uuid` AND require it is in the
     * Clinical Copilot category subtree.
     *
     * @return array{url: string, mimetype: string, encrypted: bool}|null
     */
    private function lookupDocument(int $pid, string $uuidBinary): ?array
    {
        $row = QueryUtils::fetchRecords(
            "SELECT d.url AS url, d.mimetype AS mimetype, d.encrypted AS encrypted
               FROM documents d
               JOIN categories_to_documents cd
                 ON cd.document_id = d.id
               JOIN categories leaf
                 ON leaf.id = cd.category_id
               JOIN categories root
                 ON root.id = leaf.parent
              WHERE d.foreign_id = ?
                AND d.uuid = ?
                AND d.deleted = 0
                AND root.name = ?
              LIMIT 1",
            [$pid, $uuidBinary, self::ROOT_CATEGORY_NAME],
            true,
        );
        if (count($row) === 0) {
            return null;
        }
        $first = $row[0];
        $url = is_string($first['url'] ?? null) ? $first['url'] : '';
        $mimetype = is_string($first['mimetype'] ?? null) ? $first['mimetype'] : '';
        $encryptedRaw = $first['encrypted'] ?? 0;
        // OpenEMR's column is TINYINT; DBAL returns it as int or
        // numeric string depending on the platform. Accept both.
        $encrypted = is_int($encryptedRaw) ? $encryptedRaw === 1
            : (is_string($encryptedRaw) && $encryptedRaw === '1');
        if ($url === '') {
            return null;
        }
        return ['url' => $url, 'mimetype' => $mimetype, 'encrypted' => $encrypted];
    }

    /**
     * Decrypt bytes that were stored with OpenEMR's at-rest encryption
     * (the legacy Documents UI flips `documents.encrypted=1` when the
     * site has `drive_encryption` on). Mirrors {@see \Document::decrypt_content}
     * — same crypto helper, same key source — so the bytes we return
     * are identical to what the Documents UI would render.
     */
    private function decryptBytes(string $cipher): ?string
    {
        try {
            $cryptoGen = ServiceContainer::getCrypto();
            $plain = $cryptoGen->decryptStandard($cipher, keySource: KeySource::Database);
        } catch (\RuntimeException | \UnexpectedValueException | \DomainException $e) {
            // CryptoGen surfaces decode failures as RuntimeException;
            // missing/wrong-key as UnexpectedValueException. Wrong-shape
            // ciphertext occasionally surfaces as DomainException. Any
            // of these mean we can't decrypt — surface as null to the
            // caller, which translates to 503 storage_unreachable.
            $this->logger->warning('Agent document-bytes: decryption failed', [
                'exception' => $e,
            ]);
            return null;
        }
        if ($plain === false || $plain === '') {
            return null;
        }
        return $plain;
    }

    /**
     * Translate a `documents.url` into an absolute filesystem path
     * we can read. Strict allowlist:
     *
     *   - Only `file://` URLs are honored. The legacy Documents UI
     *     writes these for local-disk storage; remote storage backends
     *     (CouchDB, S3) use other types we don't support here.
     *   - The resolved path must canonicalize under the configured
     *     site documents root. Anything outside (e.g. via `..`) is
     *     refused — defense in depth even though the schema doesn't
     *     allow that today.
     */
    private function resolveFilesystemPath(string $url): ?string
    {
        if (!str_starts_with($url, 'file://')) {
            return null;
        }
        $raw = substr($url, strlen('file://'));
        // file:// in the documents.url uses three slashes for
        // absolute paths; substr above leaves a leading slash, which
        // is what realpath wants.
        $real = realpath($raw);
        if ($real === false) {
            return null;
        }
        $rootReal = realpath($this->siteDocumentsRoot);
        if ($rootReal === false) {
            return null;
        }
        // Ensure the resolved file lives under the documents root.
        if (!str_starts_with($real, rtrim($rootReal, '/') . '/')) {
            return null;
        }
        return $real;
    }

    private function respondError(int $status, string $code): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json');
        }
        echo json_encode(['error' => $code], JSON_THROW_ON_ERROR);
    }
}
