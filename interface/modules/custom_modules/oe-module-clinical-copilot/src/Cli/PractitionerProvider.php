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

use OpenEMR\Modules\ClinicalCopilot\Settings\PractitionerSettings;

/**
 * Read-side seam for the orchestrator. The Settings module's
 * {@see \OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository}
 * is `final readonly`, so isolated tests cannot subclass it. This
 * interface exists so the orchestrator can be unit-tested against an
 * in-memory provider while production wiring delegates to the real
 * repository.
 */
interface PractitionerProvider
{
    /**
     * @return list<PractitionerSettings>
     */
    public function findEnabledPractitioners(): array;
}
