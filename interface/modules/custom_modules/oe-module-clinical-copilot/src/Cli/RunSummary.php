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
 * Aggregate outcome of a single `agent:precompute-day` run. The
 * Console command surfaces these via `SymfonyStyle` and uses them to
 * pick the exit code (`SUCCESS` for partial-success / empty runs,
 * `FAILURE` only on full-day failures).
 *
 * No PHI here — counters only. Per-slot detail goes to the structured
 * log via `BriefingHttpClient` and the orchestrator's PSR-3 logger.
 */
final readonly class RunSummary
{
    public function __construct(
        public int $practitionersConsidered,
        public int $practitionersInWindow,
        public int $slotsAttempted,
        public int $slotsWritten,
        public int $slotsOverwritten,
        public int $slotsSkippedIdempotent,
        public int $slotsErrored,
    ) {
    }

    public static function empty(): self
    {
        return new self(0, 0, 0, 0, 0, 0, 0);
    }

    public function isFullDayFailure(): bool
    {
        return $this->slotsErrored > 0 && $this->slotsWritten === 0 && $this->slotsOverwritten === 0;
    }

    /**
     * @return array<string, int>
     */
    public function toLogContext(): array
    {
        return [
            'practitionersConsidered' => $this->practitionersConsidered,
            'practitionersInWindow' => $this->practitionersInWindow,
            'slotsAttempted' => $this->slotsAttempted,
            'slotsWritten' => $this->slotsWritten,
            'slotsOverwritten' => $this->slotsOverwritten,
            'slotsSkippedIdempotent' => $this->slotsSkippedIdempotent,
            'slotsErrored' => $this->slotsErrored,
        ];
    }
}
