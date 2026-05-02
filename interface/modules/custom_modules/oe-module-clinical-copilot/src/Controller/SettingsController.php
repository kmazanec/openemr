<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller;

use DateTimeImmutable;
use DateTimeZone;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyDenyReason;
use OpenEMR\Modules\ClinicalCopilot\Settings\PractitionerSettings;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsControllerResult;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsPolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository;

/**
 * Application service for the per-practitioner morning-prep settings form.
 *
 * Validates form input, evaluates self-write policy, persists the row.
 * The page-level entry point ({@see /public/settings.php}) handles HTTP
 * concerns (CSRF, session resolution, Twig render); this object is
 * reusable from a CLI test or future API endpoint without HTTP coupling.
 */
final readonly class SettingsController
{
    public function __construct(
        private SettingsRepository $repository,
        private SettingsPolicyGate $policyGate,
        private ClockInterface $clock,
    ) {
    }

    public function save(
        string $actingPractitionerUuid,
        string $targetPractitionerUuid,
        bool $morningPrepEnabled,
        string $morningPrepTimeLocal,
        string $timezone,
    ): SettingsControllerResult {
        $decision = $this->policyGate->evaluateWrite($actingPractitionerUuid, $targetPractitionerUuid);
        if ($decision->reason instanceof PolicyDenyReason) {
            return SettingsControllerResult::failure([
                'policy' => $decision->reason->name,
            ]);
        }

        $errors = [];

        $normalizedTime = $this->normalizeTime($morningPrepTimeLocal);
        if ($normalizedTime === null) {
            $errors['morning_prep_time_local'] = 'Time must be a valid 24-hour H:i or H:i:s';
        }

        if (!$this->isValidTimezone($timezone)) {
            $errors['timezone'] = 'Timezone must be a valid IANA identifier';
        }

        if ($errors !== []) {
            return SettingsControllerResult::failure($errors);
        }

        // PHPStan narrows $normalizedTime to non-null here: the only path
        // that leaves it null sets $errors['morning_prep_time_local'],
        // which the early return above covers.
        $row = new PractitionerSettings(
            practitionerUuid: $targetPractitionerUuid,
            morningPrepEnabled: $morningPrepEnabled,
            morningPrepTimeLocal: $normalizedTime,
            timezone: $timezone,
            updatedAt: $this->clock->now(),
        );
        $this->repository->upsert($row);

        return SettingsControllerResult::success($row);
    }

    /**
     * Accepts `H:i` (the HTML5 `<input type="time">` default) or `H:i:s`,
     * returns canonical `H:i:s` for storage. Rejects everything else
     * including `25:99`, empty strings, and stray whitespace.
     */
    private function normalizeTime(string $raw): ?string
    {
        if ($raw === '') {
            return null;
        }
        foreach (['H:i:s', 'H:i'] as $format) {
            $parsed = DateTimeImmutable::createFromFormat('!' . $format, $raw);
            if ($parsed !== false && $parsed->format($format) === $raw) {
                return $parsed->format('H:i:s');
            }
        }
        return null;
    }

    private function isValidTimezone(string $tz): bool
    {
        if ($tz === '') {
            return false;
        }
        // listIdentifiers() returns the canonical IANA set; comparing the
        // input directly avoids catching DateTimeZone's constructor throw,
        // which the project's forbidden-catch-type rule would flag.
        return in_array($tz, DateTimeZone::listIdentifiers(), strict: true);
    }
}
