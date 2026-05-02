<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Cli;

/**
 * §5.3 SSE consumer surface. The orchestrator POSTs a precompute
 * envelope to the agent's `/v1/agent/briefing` endpoint and reads the
 * SSE stream for the typed `done` event whose `precompute.outcome`
 * field tells the orchestrator whether the row was inserted,
 * overwritten, or skipped idempotently.
 *
 * Carved out as an interface so isolated tests can drive the
 * orchestrator without Guzzle, the network, or the agent service.
 * Production wiring is `GuzzleBriefingHttpClient`.
 */
interface BriefingHttpClient
{
    /**
     * @param array<string, mixed> $envelope JSON-encoded body
     *
     * @throws BriefingHttpException on any non-2xx, network failure,
     *                               or malformed SSE stream
     */
    public function postBriefing(string $url, string $bearerToken, array $envelope): BriefingHttpOutcome;
}
