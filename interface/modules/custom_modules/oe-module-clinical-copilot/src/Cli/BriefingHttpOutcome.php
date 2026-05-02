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
 * One slot's terminal SSE event reduced to the bits the orchestrator
 * needs to update its `RunSummary`. Errors come through as exceptions
 * (see {@see BriefingHttpException}); a returned outcome always
 * represents a non-error response from the agent.
 */
final readonly class BriefingHttpOutcome
{
    public function __construct(
        /**
         * The terminal SSE event was a `done` event.
         */
        public bool $done,
        /**
         * For precompute requests: which `record()` outcome the agent
         * reported. Null for non-precompute responses (the orchestrator
         * does not consume those today).
         */
        public ?string $precomputeOutcome,
        /**
         * Echoed back from the envelope so the per-slot log line is
         * traceable to the originating request without parsing the SSE
         * body twice.
         */
        public string $appointmentId,
    ) {
    }
}
