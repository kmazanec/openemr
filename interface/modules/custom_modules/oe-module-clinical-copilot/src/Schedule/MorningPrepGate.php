<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Schedule;

use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository;

/**
 * §5.4 opt-in check that runs before the agent proxy mints a token for
 * the schedule-view annotations action. The agent's `schedule_briefings`
 * route happily returns an empty list for any non-opted-in practitioner,
 * but the round-trip itself is wasted work — the schedule view fires the
 * fetch on every page load. Short-circuiting at the proxy boundary keeps
 * the disabled-default cost story honest: zero tokens *and* zero network
 * calls for clinicians who haven't opted in.
 *
 * The gate intentionally fails *open* on lookup errors. A broken settings
 * read should not break the schedule view; it should just behave as if
 * the user is opted in (and let the agent's own emptiness story take
 * over). The alternative — failing closed — would silently erase
 * annotations for every clinician the moment the settings table had any
 * trouble, which is the worse failure mode.
 */
final readonly class MorningPrepGate
{
    public function __construct(private SettingsRepository $repository)
    {
    }

    public function isEnabledFor(string $practitionerUuid): bool
    {
        if ($practitionerUuid === '') {
            return false;
        }
        try {
            $settings = $this->repository->find($practitionerUuid);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception) {
            // Fail open — see class docblock. The catch list mirrors
            // the rest of the module: SettingsRepository::find may
            // raise RuntimeException on a malformed row or DBAL\Exception
            // on a driver-level failure. Both should degrade to
            // "let the agent's empty-list response take over" rather
            // than blanking the schedule view.
            return true;
        }
        if ($settings === null) {
            return false;
        }
        return $settings->morningPrepEnabled;
    }
}
