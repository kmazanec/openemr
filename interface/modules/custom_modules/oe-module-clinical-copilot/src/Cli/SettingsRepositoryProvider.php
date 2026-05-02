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

use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository;

/**
 * Production {@see PractitionerProvider} that delegates to
 * {@see SettingsRepository}.
 */
final readonly class SettingsRepositoryProvider implements PractitionerProvider
{
    public function __construct(private SettingsRepository $repository)
    {
    }

    public function findEnabledPractitioners(): array
    {
        return $this->repository->findEnabledPractitioners();
    }
}
