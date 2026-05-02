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

use DateInterval;

/**
 * Options for one invocation of `agent:precompute-day`. The command
 * parses CLI flags into this DTO so the orchestrator stays
 * framework-free and can be unit-tested without `CommandTester`.
 */
final readonly class RunOptions
{
    public function __construct(
        /**
         * Cron-tick width. The orchestrator treats a practitioner as
         * "in window" when the practitioner's local prep time falls
         * inside `[now - 0, now - window)` — i.e. the window leads
         * the current tick. Default 1 hour matches the typical hourly
         * cron cadence.
         */
        public DateInterval $window,
        /**
         * Hard overwrite: bypass the in-orchestrator existence check
         * and force the agent's `record()` path to delete-then-insert
         * matching rows. Used for debug reruns when the cached output
         * is stale or wrong.
         */
        public bool $force = false,
        /**
         * Only run for this practitioner uuid (debug). When set, the
         * window predicate still applies — the operator typically
         * combines this with a manual time fixture, not as a way to
         * bypass scheduling.
         */
        public ?string $practitionerUuid = null,
        /**
         * Skip the agent POST entirely. The orchestrator still loops
         * the in-window practitioner set and logs what it *would* have
         * done. Useful for verifying the windowing predicate against
         * a live settings table without spending tokens.
         */
        public bool $dryRun = false,
    ) {
    }
}
