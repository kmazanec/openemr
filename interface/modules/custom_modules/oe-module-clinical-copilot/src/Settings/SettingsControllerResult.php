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

/**
 * Outcome of one {@see \OpenEMR\Modules\ClinicalCopilot\Controller\SettingsController::save}
 * call. The page entry point branches on `ok` to render either the success
 * banner or per-field error messages without scraping HTTP output.
 *
 * `errors` is a flat field-name → reason map. The reserved key `policy`
 * carries the {@see \OpenEMR\Modules\ClinicalCopilot\Auth\PolicyDenyReason}
 * `name` for self-write violations; per-input errors use the form field
 * name (`morning_prep_time_local`, `timezone`).
 */
final readonly class SettingsControllerResult
{
    /**
     * @param array<string, string> $errors
     */
    public function __construct(
        public bool $ok,
        public array $errors,
        public ?PractitionerSettings $savedRow,
    ) {
    }

    public static function success(PractitionerSettings $row): self
    {
        return new self(true, [], $row);
    }

    /**
     * @param array<string, string> $errors
     */
    public static function failure(array $errors): self
    {
        return new self(false, $errors, null);
    }
}
