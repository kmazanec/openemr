<?php

/**
 * Clinical Co-Pilot module entrypoint.
 *
 * Loaded by OpenEMR's ModulesApplication when the module is enabled in
 * the modules table. Phase 1.3 just registers the module's PSR-4
 * namespace; Phase 1.4 starts instantiating Bootstrap and wiring
 * listeners here.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

use OpenEMR\Core\ModulesClassLoader;
use OpenEMR\Core\OEGlobalsBag;

$classLoader = new ModulesClassLoader(OEGlobalsBag::getInstance()->getProjectDir());
$classLoader->registerNamespaceIfNotExists(
    'OpenEMR\\Modules\\ClinicalCopilot\\',
    __DIR__ . DIRECTORY_SEPARATOR . 'src',
);

// Phase 1.3 skeleton: PSR-4 autoload registered, no event listeners
// yet. Phase 1.4 instantiates Bootstrap with the event dispatcher and
// calls subscribeToEvents() when the proxy controller lands.
