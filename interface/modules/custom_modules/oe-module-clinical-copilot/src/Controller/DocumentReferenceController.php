<?php

/**
 * Tier-1 endpoint controller — invoked by the agent service after the
 * ingestion pipeline confirms the canonical bytes are in Spaces. The
 * agent posts `{pid, doc_type, spaces_url, mime_type, filename}` and
 * receives `{document_uuid, document_row_id}`.
 *
 * Auth surface mirrors the narrow snapshot controllers (JWT bearer →
 * {@see AgentEndpointAuth}); the required scope is `user/DocumentReference.cs`
 * (write-shaped: SMART `c` for create, `s` for search). The agent's
 * minted JWT must carry that scope.
 *
 * Disclosure shape: one {@see AgentDisclosure} per write with
 * `action='document_reference_write'` and `categories=['document']`.
 * The agent_request_log table picks this up via the existing
 * {@see AgentDisclosureListener}.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller;

use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentReferenceWriteService;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class DocumentReferenceController
{
    public const REQUIRED_SCOPE = 'user/DocumentReference.cs';

    private const MAX_FILENAME_LENGTH = 255;
    private const MAX_URL_LENGTH = 1024;
    private const MAX_MIME_LENGTH = 100;

    public function __construct(
        private AgentEndpointAuth $auth,
        private DocumentReferenceWriteService $writeService,
        private EventDispatcherInterface $eventDispatcher,
        private LoggerInterface $logger,
        private string $siteId,
        private ClockInterface $clock,
    ) {
    }

    /**
     * @param array<string, mixed>|null $body
     */
    public function handle(
        ?string $bearerToken,
        ?array $body,
        ?string $conversationId,
    ): void {
        $request = $this->auth->authorize($bearerToken, self::REQUIRED_SCOPE);
        if ($request === null) {
            return;
        }

        if ($body === null) {
            $this->respondError(400, 'invalid_body');
            return;
        }

        $pid = $this->parsePositiveInt($body['pid'] ?? null);
        if ($pid === null) {
            $this->respondError(400, 'missing_pid');
            return;
        }

        $docTypeRaw = $body['doc_type'] ?? null;
        if (
            !is_string($docTypeRaw)
            || (
                $docTypeRaw !== DocumentReferenceWriteService::DOC_TYPE_LAB_PDF
                && $docTypeRaw !== DocumentReferenceWriteService::DOC_TYPE_INTAKE_FORM
            )
        ) {
            $this->respondError(400, 'invalid_doc_type');
            return;
        }

        $spacesUrl = $this->parseBoundedString($body['spaces_url'] ?? null, self::MAX_URL_LENGTH);
        if ($spacesUrl === null || !str_starts_with($spacesUrl, 's3://')) {
            $this->respondError(400, 'invalid_spaces_url');
            return;
        }

        $mimeType = $this->parseBoundedString($body['mime_type'] ?? null, self::MAX_MIME_LENGTH);
        if ($mimeType === null) {
            $this->respondError(400, 'invalid_mime_type');
            return;
        }

        $filename = $this->parseBoundedString($body['filename'] ?? null, self::MAX_FILENAME_LENGTH);
        if ($filename === null) {
            $this->respondError(400, 'invalid_filename');
            return;
        }

        try {
            $documentUuid = $this->writeService->write(
                pid: $pid,
                docType: $docTypeRaw,
                spacesUrl: $spacesUrl,
                mimeType: $mimeType,
                filename: $filename,
            );
        } catch (\DomainException $e) {
            $this->logger->warning('Tier-1 endpoint rejected validated input', [
                'pid' => $pid,
                'docType' => $docTypeRaw,
                'reason' => $e->getMessage(),
            ]);
            $this->respondError(400, 'invalid_request');
            return;
        } catch (\RuntimeException $e) {
            $this->logger->error('Tier-1 endpoint failed to write DocumentReference', [
                'pid' => $pid,
                'docType' => $docTypeRaw,
                'exception' => $e,
            ]);
            $this->respondError(503, 'write_unavailable');
            return;
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
                    action: 'document_reference_write',
                    requestId: $request->verified->jti,
                    categories: ['document'],
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            // The disclosure write failed but the DocumentReference is
            // already in `documents`. Log loudly; respond success — the
            // chart row exists, refusing to acknowledge it would create
            // a phantom-mismatch between OpenEMR and the agent's
            // extraction_artifacts. The disclosure side is recoverable
            // via the agent_request_log replay path.
            $this->logger->error('Tier-1 disclosure write failed (DocumentReference already persisted)', [
                'pid' => $pid,
                'documentUuid' => $documentUuid,
                'exception' => $e,
            ]);
        }

        $this->respondJson(200, [
            'document_uuid' => $documentUuid,
        ]);
    }

    private function parsePositiveInt(mixed $raw): ?int
    {
        if (is_int($raw) && $raw > 0) {
            return $raw;
        }
        if (is_string($raw) && ctype_digit($raw)) {
            $val = (int) $raw;
            return $val > 0 ? $val : null;
        }
        return null;
    }

    private function parseBoundedString(mixed $raw, int $max): ?string
    {
        if (!is_string($raw)) {
            return null;
        }
        $trimmed = trim($raw);
        if ($trimmed === '' || strlen($trimmed) > $max) {
            return null;
        }
        return $trimmed;
    }

    private function respondError(int $status, string $code): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json');
        }
        echo json_encode(['error' => $code], JSON_THROW_ON_ERROR);
    }

    /**
     * @param array<string, mixed> $body
     */
    private function respondJson(int $status, array $body): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json');
        }
        echo json_encode($body, JSON_THROW_ON_ERROR);
    }
}
