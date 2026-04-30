<?php

/**
 * Clinical Co-Pilot module Bootstrap.
 *
 * Phase 1.4 ships the proxy controller as a public entry .php
 * (`public/agent.php`); no module-level event subscriptions are needed
 * for the proxy hop. This class will gain an EventDispatcher constructor
 * parameter and a subscribeToEvents() method when Phase 3 lands the
 * patient-chart button (UI hook into the chart render event).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot;

final class Bootstrap
{
    public const MODULE_NAME = 'oe-module-clinical-copilot';

    public const MODULE_INSTALLATION_PATH = '/interface/modules/custom_modules/' . self::MODULE_NAME;
}
