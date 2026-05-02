<?php

/**
 * Clinical Co-Pilot — per-practitioner morning-prep settings page.
 *
 * GET renders the form pre-populated with the acting practitioner's row
 * (or defaults if no row yet). POST validates CSRF, hands the form to
 * {@see SettingsController}, and re-renders with field errors or a
 * success flash.
 *
 * The page is session-authenticated through OpenEMR's normal `globals.php`
 * bootstrap; it does not go through the agent proxy. Self-only enforcement
 * is handled by {@see SettingsPolicyGate}, called from inside the
 * controller — there is no admin-edits-others surface this sprint.
 *
 * Routing:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/public/settings.php
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../../../globals.php';

use DateTimeImmutable;
use DateTimeZone;
use OpenEMR\Common\Acl\AccessDeniedHelper;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Csrf\CsrfUtils;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Common\Twig\TwigContainer;
use OpenEMR\Core\Header;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Auth\SqlUuidLookup;
use OpenEMR\Modules\ClinicalCopilot\Auth\SystemClock;
use OpenEMR\Modules\ClinicalCopilot\Controller\SettingsController;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDbalConnection;
use OpenEMR\Modules\ClinicalCopilot\Settings\PractitionerSettings;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsPolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository;
use Symfony\Component\HttpFoundation\Request;

if (!AclMain::aclCheckCore('patients', 'med')) {
    AccessDeniedHelper::denyWithTemplate(
        'ACL check failed for patients/med: Clinical Co-Pilot settings',
        xl('Clinical Co-Pilot settings'),
    );
}

$request = Request::createFromGlobals();
$session = SessionWrapperFactory::getInstance()->getActiveSession();

$authUserIdRaw = $session->get('authUserID');
$authUserId = is_scalar($authUserIdRaw) ? (int) $authUserIdRaw : 0;
if ($authUserId <= 0) {
    AccessDeniedHelper::denyWithTemplate(
        'Clinical Co-Pilot settings: no authenticated user in session',
        xl('Clinical Co-Pilot settings'),
    );
}

$uuidLookup = new SqlUuidLookup();
$practitionerUuid = $uuidLookup->uuidForUserId($authUserId) ?? '';
if ($practitionerUuid === '') {
    AccessDeniedHelper::denyWithTemplate(
        'Clinical Co-Pilot settings: session user could not be resolved to a Practitioner uuid',
        xl('Clinical Co-Pilot settings'),
    );
}

$repository = new SettingsRepository(AgentDbalConnection::get());
$controller = new SettingsController($repository, new SettingsPolicyGate(), new SystemClock());

$globals = OEGlobalsBag::getInstance();
$siteTimezoneRaw = $globals->get('gbl_time_zone');
$siteTimezone = is_string($siteTimezoneRaw) && $siteTimezoneRaw !== '' ? $siteTimezoneRaw : 'America/Chicago';

$result = null;
if ($request->isMethod('POST')) {
    $csrf = (string) $request->request->get('csrf_token_form', '');
    if (!CsrfUtils::verifyCsrfToken($csrf, session: $session)) {
        CsrfUtils::csrfNotVerified();
    }

    $result = $controller->save(
        actingPractitionerUuid: $practitionerUuid,
        targetPractitionerUuid: $practitionerUuid,
        morningPrepEnabled: $request->request->getBoolean('morning_prep_enabled'),
        morningPrepTimeLocal: (string) $request->request->get('morning_prep_time_local', ''),
        timezone: (string) $request->request->get('timezone', ''),
    );
}

$existing = $repository->find($practitionerUuid);
$savedRow = ($result !== null && $result->ok && $result->savedRow !== null) ? $result->savedRow : null;
$displayRow = $savedRow ?? $existing ?? new PractitionerSettings(
    practitionerUuid: $practitionerUuid,
    morningPrepEnabled: false,
    morningPrepTimeLocal: '07:50:00',
    timezone: $siteTimezone,
    updatedAt: new DateTimeImmutable('@0'),
);

$twig = (new TwigContainer(__DIR__ . '/../templates'))->getTwig();

echo $twig->render('settings.html.twig', [
    'commonHeader' => Header::setupHeader([], false),
    'csrfToken' => CsrfUtils::collectCsrfToken(session: $session),
    'enabled' => $displayRow->morningPrepEnabled,
    'timeLocal' => substr((string) $displayRow->morningPrepTimeLocal, 0, 5),
    'timezone' => $displayRow->timezone,
    'timezones' => DateTimeZone::listIdentifiers(),
    'errors' => $result !== null ? $result->errors : [],
    'savedAt' => $savedRow?->updatedAt->format(DATE_ATOM),
    'isFreshRow' => $existing === null && $result === null,
]);
