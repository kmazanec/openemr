<?php

/**
 * Clinical Co-Pilot module Bootstrap.
 *
 * Phase 1.3 skeleton: just module-level constants. Phase 1.4 (proxy
 * controller) gives this class an EventDispatcher constructor parameter
 * and a subscribeToEvents() method, and openemr.bootstrap.php starts
 * instantiating it.
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
