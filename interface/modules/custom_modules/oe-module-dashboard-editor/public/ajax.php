<?php

/**
 * Browser entry point for the Dashboard Editor module.
 *
 * Single same-origin endpoint that the new dashboard SPA calls when
 * a doctor uses one of the in-page edit/add modals (allergies,
 * medical problems, medications, prescriptions, lab results, vitals,
 * care team). Reads still flow through the FHIR layer; this surface
 * exists for the writes the FHIR layer doesn't support.
 *
 * Routing: a single `action` query/body parameter dispatches inside
 * `EditorController` so the SPA only needs one URL — there's no
 * dynamic-route layer to introduce here.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../../../globals.php';

use OpenEMR\Core\ModulesClassLoader;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\DashboardEditor\Controller\EditorController;

// Register the module's PSR-4 namespace at the entry point so the
// controller class is discoverable without requiring the module to be
// enabled in the modules table — this endpoint exists purely as a
// session-authed write surface for the dashboard SPA.
$classLoader = new ModulesClassLoader(OEGlobalsBag::getInstance()->getProjectDir());
$classLoader->registerNamespaceIfNotExists(
    'OpenEMR\\Modules\\DashboardEditor\\',
    dirname(__DIR__) . DIRECTORY_SEPARATOR . 'src',
);

$controller = new EditorController();
$controller->handleRequest();
