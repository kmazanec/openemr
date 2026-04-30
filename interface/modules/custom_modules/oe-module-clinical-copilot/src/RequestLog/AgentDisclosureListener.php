<?php

/**
 * Listens for {@see AgentDisclosedEvent} and dispatches to two recorders:
 *
 *  1. {@see DisclosureRecorder} — regulatory trail in OpenEMR's `extended_log`,
 *     deduped per (actor, patient, day). Surfaces in the patient's HIPAA
 *     Accounting of Disclosures (§164.528) report. **Fail-closed**: if this
 *     write throws, the exception propagates so the controller can refuse to
 *     emit chart data. The plan (§2.4) says "emitted before any chart data
 *     leaves OpenEMR" — that means a failure here cannot be silently
 *     swallowed.
 *  2. {@see AgentRequestLogRecorder} — engineering instrumentation in the
 *     `agent_request_log` table, one row per request, structured categories
 *     for cost / eval / debugging queries. **Best-effort**: failures here
 *     are logged and absorbed; the regulatory trail is the audit anchor and
 *     missing engineering rows shouldn't take a request offline.
 *
 * The regulatory recorder runs first. If it succeeds, the engineering
 * recorder runs and any failure there is swallowed-and-logged. Caught types
 * for the engineering path are narrowed (DBAL, JSON, runtime) so programmer
 * errors still bubble — see ForbiddenCatchTypeRule.
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

        // Regulatory write is fail-closed: any throw propagates to the
        // controller, which converts it into a 503 and refuses to emit
        // chart data. This is the HIPAA accounting anchor.
        $this->disclosureRecorder->record($disclosure);

        // Engineering write is best-effort; absorb DBAL/JSON/runtime
        // failures and keep the request alive.
        try {
            $this->requestLogRecorder->record($disclosure);
        } catch (DbalException | JsonException | RuntimeException $e) {
            $this->logger->error('Failed to persist agent_request_log row', [
                'sink' => 'agent_request_log',
                'action' => $disclosure->action,
                'requestId' => $disclosure->requestId,
                'exception' => $e,
            ]);
        }
    }
}
