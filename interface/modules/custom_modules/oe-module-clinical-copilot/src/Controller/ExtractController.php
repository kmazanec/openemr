<?php

/**
 * §B.8 Browser → Agent ingestion-pipeline trigger controller.
 *
 * Path A (panel upload during a conversation): the browser POSTs a
 * just-uploaded document's metadata; this controller validates the body
 * shape, builds an `AgentRequest` with the `extract` action, and
 * delegates to a dispatcher (the production `AgentProxyController`)
 * for session + scope checks, JWT mint, and SSE streaming.
 *
 * Why a thin pre-validator vs. routing the whole thing through
 * `agent.php` directly: the body validation (pid, document_uuid,
 * doc_type, trigger_source) is endpoint-specific. Folding it into
 * `agent.php` would force every action to know the union of every
 * action's body shape. A dedicated entry point keeps that complexity
 * scoped to the action that owns it.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller;

use Closure;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentRequest;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use OpenEMR\Modules\ClinicalCopilot\Auth\SessionContext;

final readonly class ExtractController
{
    public const ACTION = 'extract';

    private const VALID_DOC_TYPES = ['lab_pdf', 'intake_form'];
    private const VALID_TRIGGER_SOURCES = ['panel', 'autosweep', 'cli'];
    private const MAX_DOCUMENT_UUID_LEN = 200;
    private const MAX_CONVERSATION_ID_LEN = 200;
    private const MAX_CANONICAL_EXT_LEN = 8;

    /**
     * Dispatcher seam — accepts `(SessionContext, AgentRequest, string $body): void`.
     * Production wires `AgentProxyController::dispatch(...)`; tests inject a
     * recording closure to assert the controller forwards what's expected.
     *
     * @param Closure(SessionContext, AgentRequest, string): void $dispatcher
     */
    public function __construct(
        private Closure $dispatcher,
    ) {
    }

    public static function fromEnvironment(string $agentBaseUrl, string $issuer): self
    {
        $proxy = AgentProxyController::fromEnvironment($agentBaseUrl, $issuer);
        return new self(static function (SessionContext $s, AgentRequest $r, string $b) use ($proxy): void {
            $proxy->dispatch($s, $r, $b);
        });
    }

    public function handle(
        string $rawBody,
        string $authUserId,
        string $authUser,
        string $siteId,
        ?string $sessionPid,
        ?ResolvedFhirUser $fhirUser,
    ): void {
        $body = json_decode($rawBody, associative: true);
        if (!is_array($body)) {
            $this->respondError(400, 'invalid_body');
            return;
        }

        $pid = $this->parsePositivePid($body['pid'] ?? null);
        if ($pid === null) {
            $this->respondError(400, 'missing_pid');
            return;
        }

        $documentUuid = $this->parseBoundedString($body['document_uuid'] ?? null, self::MAX_DOCUMENT_UUID_LEN);
        if ($documentUuid === null) {
            $this->respondError(400, 'invalid_document_uuid');
            return;
        }

        $docTypeRaw = $body['doc_type'] ?? null;
        if (!is_string($docTypeRaw) || !in_array($docTypeRaw, self::VALID_DOC_TYPES, strict: true)) {
            $this->respondError(400, 'invalid_doc_type');
            return;
        }

        $triggerRaw = $body['trigger_source'] ?? null;
        if (!is_string($triggerRaw) || !in_array($triggerRaw, self::VALID_TRIGGER_SOURCES, strict: true)) {
            $this->respondError(400, 'invalid_trigger_source');
            return;
        }

        $canonicalExt = $this->parseBoundedString($body['canonical_ext'] ?? null, self::MAX_CANONICAL_EXT_LEN)
            ?? 'pdf';

        $conversationId = isset($body['conversation_id'])
            ? $this->parseBoundedString($body['conversation_id'], self::MAX_CONVERSATION_ID_LEN)
            : null;

        $forwardBody = [
            'pid' => $pid,
            'document_uuid' => $documentUuid,
            'doc_type' => $docTypeRaw,
            'trigger_source' => $triggerRaw,
            'canonical_ext' => $canonicalExt,
        ];
        if ($conversationId !== null) {
            $forwardBody['conversation_id'] = $conversationId;
        }
        $forwardJson = json_encode($forwardBody, JSON_THROW_ON_ERROR);

        $context = new SessionContext(
            authUserId: $authUserId,
            authUser: $authUser,
            siteId: $siteId,
            patientPid: $sessionPid,
            fhirUser: $fhirUser,
        );

        $agentRequest = new AgentRequest(
            action: self::ACTION,
            siteId: $siteId,
            requestedPatientPid: (string) $pid,
            requestedScopes: (new PolicyGate())->defaultScopesFor(self::ACTION),
            extraQueryParams: [],
        );

        ($this->dispatcher)($context, $agentRequest, $forwardJson);
    }

    private function parsePositivePid(mixed $raw): ?int
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
}
