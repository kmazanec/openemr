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
use DateTimeImmutable;
use DateTimeZone;
use OpenEMR\Modules\ClinicalCopilot\Settings\PractitionerSettings;

/**
 * §5.3 cron-window predicate. Decides whether *now* falls inside the
 * `[morningPrepTimeLocal, morningPrepTimeLocal + window]` slot for a
 * given practitioner, expressed in their local timezone.
 *
 * The windowing model assumes the precompute CLI is invoked once per
 * cron tick (default hourly): a tick at 07:55 UTC sees a practitioner
 * configured for 07:50 America/Chicago as in-window when the local
 * wall-clock landed inside the [07:50, 07:50 + 1h) interval. Later
 * ticks the same day will *not* fire because the local time has moved
 * on; an idempotency check in the orchestrator handles the case where
 * a slow run rolls into the next tick.
 *
 * Comparing wall-clock-in-zone (rather than UTC offsets) is what makes
 * the predicate DST-correct: PHP's `DateTimeZone` shifts CST/CDT for
 * us, and "07:50 in America/Chicago" is the same string in both
 * winter and summer.
 */
final readonly class InWindowPredicate
{
    /**
     * Returns true iff `$now` (a UTC instant) lands inside the window
     * `[localPrepTime, localPrepTime + $window)` when re-expressed in
     * the practitioner's timezone. False if the practitioner is opted
     * out — callers should still gate on `$settings->morningPrepEnabled`
     * upstream so the per-practitioner skip stays log-line-free per
     * §5.3's "zero rows, zero log lines for opted-out" requirement.
     */
    public function __invoke(
        PractitionerSettings $settings,
        DateTimeImmutable $now,
        DateInterval $window,
    ): bool {
        if (!$settings->morningPrepEnabled) {
            return false;
        }
        $zone = new DateTimeZone($settings->timezone);
        $local = $now->setTimezone($zone);
        $localToday = $local->format('Y-m-d');
        $startLocal = DateTimeImmutable::createFromFormat(
            'Y-m-d H:i:s',
            $localToday . ' ' . $settings->morningPrepTimeLocal,
            $zone,
        );
        if ($startLocal === false) {
            // Defensive: validation at the settings-write boundary keeps
            // this from happening; if it does, the practitioner row is
            // malformed and we fail closed (don't run the precompute).
            return false;
        }
        $endLocal = $startLocal->add($window);

        return $local >= $startLocal && $local < $endLocal;
    }
}
