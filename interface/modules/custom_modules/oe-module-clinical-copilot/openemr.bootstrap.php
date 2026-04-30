<?php

/**
 * Clinical Co-Pilot module entrypoint.
 *
 * Loaded by OpenEMR's ModulesApplication when the module is enabled in
 * the modules table. Registers the module's PSR-4 namespace and
 * subscribes its event listeners — today, the patient-summary card entry
 * point and the Twig templates path needed to render it.
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
use OpenEMR\Modules\ClinicalCopilot\Bootstrap;

$classLoader = new ModulesClassLoader(OEGlobalsBag::getInstance()->getProjectDir());
$classLoader->registerNamespaceIfNotExists(
    'OpenEMR\\Modules\\ClinicalCopilot\\',
    __DIR__ . DIRECTORY_SEPARATOR . 'src',
);

if (isset($eventDispatcher)) {
    /** @var \Symfony\Component\EventDispatcher\EventDispatcherInterface $eventDispatcher */
    (new Bootstrap($eventDispatcher))->subscribeToEvents();
}
