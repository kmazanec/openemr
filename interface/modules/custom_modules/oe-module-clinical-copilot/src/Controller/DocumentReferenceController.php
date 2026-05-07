<?php

/**
 * Tier-1 endpoint controller — invoked by the agent service after the
 * ingestion pipeline confirms the canonical bytes are in Spaces.
 *
 * Contract: chat uploads pre-write the `documents` row at the
 * {@see DocumentUploadController} boundary so the row is identical-on-
 * disk to a legacy Documents-tab upload (`type='file_url'`,
 * `path_depth=1`, `url='file://...'`). The agent posts only enough to
 * confirm the existing row by UUID:
 *   `{pid, doc_type, document_uuid}` → `{document_uuid}`
 *
 * The endpoint validates the caller's `pid` and `doc_type` claims
 * against the pre-written row before acknowledging it (security
 * against a malformed JWT carrying the wrong scope's pid). When no row
 * exists for the supplied UUID it returns HTTP 409 with
 * `error: document_not_pre_written`, which the persist node maps to
 * `persist_failed`.
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

    private const MAX_UUID_LENGTH = 36;

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

        $documentUuid = $this->parseBoundedString($body['document_uuid'] ?? null, self::MAX_UUID_LENGTH);
        if ($documentUuid === null) {
            $this->respondError(400, 'missing_document_uuid');
            return;
        }

        try {
            $confirmed = $this->writeService->confirmExisting(
                pid: $pid,
                docType: $docTypeRaw,
                documentUuid: $documentUuid,
            );
        } catch (\DomainException $e) {
            $reason = $e->getMessage();
            $code = match ($reason) {
                'pid_mismatch', 'doc_type_mismatch' => 'identity_mismatch',
                default => 'invalid_request',
            };
            $this->logger->warning('Tier-1 endpoint refused confirm', [
                'pid' => $pid,
                'docType' => $docTypeRaw,
                'reason' => $reason,
            ]);
            $this->respondError(400, $code);
            return;
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'document_not_pre_written') {
                $this->respondError(409, 'document_not_pre_written');
                return;
            }
            $this->logger->error('Tier-1 endpoint failed to confirm DocumentReference', [
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
                'documentUuid' => $confirmed,
                'exception' => $e,
            ]);
        }

        $this->respondJson(200, [
            'document_uuid' => $confirmed,
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
