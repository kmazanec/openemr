<?php

/**
 * Dashboard Editor module entrypoint.
 *
 * Loaded by OpenEMR's ModulesApplication when the module is enabled
 * in the modules table. Registers the module's PSR-4 namespace so
 * `public/ajax.php` (the same-origin write endpoint the new
 * dashboard SPA POSTs to) can resolve `EditorController` without a
 * separate composer install step.
 *
 * No event subscribers — this module is a pure HTTP surface, not an
 * event listener.
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
    'OpenEMR\\Modules\\DashboardEditor\\',
    __DIR__ . DIRECTORY_SEPARATOR . 'src',
);
