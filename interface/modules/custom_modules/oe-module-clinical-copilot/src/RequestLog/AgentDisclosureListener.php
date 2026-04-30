<?php

/**
 * Listens for {@see AgentDisclosedEvent} and dispatches to two recorders:
 *
 *  1. {@see DisclosureRecorder} — regulatory trail in OpenEMR's `extended_log`,
 *     deduped per (actor, patient, day). Surfaces in the patient's HIPAA
 *     Accounting of Disclosures (§164.528) report.
 *  2. {@see AgentRequestLogRecorder} — engineering instrumentation in the
 *     `agent_request_log` table, one row per request, structured categories
 *     for cost / eval / debugging queries.
 *
 * Each recorder is invoked independently. A failure in one does not block
 * the other or the request flow — the listener logs and keeps moving so a
 * single recorder bug can't take the proxy offline. Caught types are
 * narrowed (DBAL, JSON, runtime) so programmer errors still bubble — see
 * ForbiddenCatchTypeRule.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\RequestLog;

use Doctrine\DBAL\Exception as DbalException;
use JsonException;
use Psr\Log\LoggerInterface;
use RuntimeException;

final readonly class AgentDisclosureListener
{
    public function __construct(
        private DisclosureRecorder $disclosureRecorder,
        private AgentRequestLogRecorder $requestLogRecorder,
        private LoggerInterface $logger,
    ) {
    }

    public function __invoke(AgentDisclosedEvent $event): void
    {
        $disclosure = $event->getDisclosure();

        $this->safeRecord(
            'extended_log',
            fn() => $this->disclosureRecorder->record($disclosure),
            $disclosure,
        );

        $this->safeRecord(
            'agent_request_log',
            fn() => $this->requestLogRecorder->record($disclosure),
            $disclosure,
        );
    }

    private function safeRecord(string $sink, \Closure $write, AgentDisclosure $disclosure): void
    {
        try {
            $write();
        } catch (DbalException | JsonException | RuntimeException $e) {
            $this->logger->error('Failed to persist agent disclosure row', [
                'sink' => $sink,
                'action' => $disclosure->action,
                'requestId' => $disclosure->requestId,
                'exception' => $e,
            ]);
        }
    }
}
