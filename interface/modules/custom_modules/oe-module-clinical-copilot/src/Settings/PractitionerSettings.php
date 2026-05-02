<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Settings;

use DateTimeImmutable;

/**
 * Per-practitioner morning-prep opt-in (UC5).
 *
 * `morningPrepTimeLocal` is the wall-clock H:i:s the practitioner wants
 * the precompute to fire at, interpreted in `timezone`. The job (§5.3)
 * converts these to UTC at run time so a single CRON tick can fan out
 * across timezones.
 *
 * Validation lives at construction sites
 * ({@see \OpenEMR\Modules\ClinicalCopilot\Controller\SettingsController}):
 * by the time a PractitionerSettings exists, its time string is a valid
 * `H:i:s`, its timezone is a valid IANA identifier, and its uuid is
 * non-empty. Downstream code (the repository, the precompute job) does
 * not re-validate.
 */
final readonly class PractitionerSettings
{
    public function __construct(
        public string $practitionerUuid,
        public bool $morningPrepEnabled,
        public string $morningPrepTimeLocal,
        public string $timezone,
        public DateTimeImmutable $updatedAt,
    ) {
    }
}
