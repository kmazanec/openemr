<?php

/**
 * main_v2_launch.php — issues a fresh SMART EHR launch token.
 *
 * Why this exists. The launch token carries the active patient UUID
 * and is consumed by OpenEMR's authorization server during the
 * SMART OAuth dance. main_v2.php builds a launch token at page
 * render time, but at that moment there's typically no patient in
 * the session yet. The user picks a patient *after* the page
 * loads (via the legacy patient finder iframe → RTop.location →
 * shimmed into the SPA), at which point the original token has
 * stale (empty) patient context.
 *
 * This endpoint accepts the legacy integer pid that the patient
 * finder hands the SPA, looks up the canonical patient UUID, and
 * returns a freshly-built encrypted launch token bound to that
 * patient. The SPA invokes it just before `FHIR.oauth2.authorize()`
 * so the OAuth server's EHR-launch-skip path issues an access
 * token whose `context` includes `patient: <uuid>`.
 *
 * Auth model. The endpoint trusts the OpenEMR core session cookie
 * (the same one that authorized the dashboard SPA load and the
 * OAuth flow). It expects `APICSRFTOKEN` to match the active
 * session's API CSRF token, mirroring the LocalApi pattern used
 * elsewhere in main_v2.php.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @copyright Copyright (c) 2026 OpenCoreEMR Inc <https://opencoreemr.com/>
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

$sessionAllowWrite = false;
require_once(__DIR__ . '/../../globals.php');

use OpenEMR\BC\ServiceContainer;
use OpenEMR\Common\Csrf\CsrfUtils;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\FHIR\Config\ServerConfig;
use OpenEMR\FHIR\SMART\SMARTLaunchToken;
use OpenEMR\Services\PatientService;

header('Content-Type: application/json');

$session = SessionWrapperFactory::getInstance()->getActiveSession();

// Same auth gate as main_v2.php's LocalApi calls: the user must
// be authenticated AND the request must include a CSRF token that
// matches the session's API CSRF token.
$authUserId = $session->get('authUserID');
if (in_array($authUserId, [null, '', 0], true)) {
    http_response_code(401);
    echo json_encode(['error' => 'not authenticated']);
    exit();
}

$csrfHeader = filter_input(INPUT_SERVER, 'HTTP_APICSRFTOKEN');
$csrfHeaderStr = is_string($csrfHeader) ? $csrfHeader : '';
if ($csrfHeaderStr === '' || !CsrfUtils::verifyCsrfToken($csrfHeaderStr, $session, 'api')) {
    http_response_code(403);
    echo json_encode(['error' => 'csrf mismatch']);
    exit();
}

$pidParam = filter_input(INPUT_GET, 'pid');
$puuid = null;
if (is_string($pidParam) && $pidParam !== '') {
    $pid = (int) $pidParam;
    if ($pid > 0) {
        try {
            $patientService = new PatientService();
            // PatientService::getUuid is declared `string $pid`; under
            // strict_types we have to pass a string explicitly.
            $puuidBytes = $patientService->getUuid((string) $pid);
            if (is_string($puuidBytes) && $puuidBytes !== '') {
                $puuid = UuidRegistry::uuidToString($puuidBytes);
            }
        } catch (\Throwable $e) {
            // Log the failure for diagnostics, then re-throw so the
            // global exception handler turns it into a 500. We
            // intentionally don't swallow the exception — a launch
            // token without a valid patient context would mislead
            // downstream FHIR auth.
            ServiceContainer::getLogger()->error(
                'main_v2_launch: getUuid failed',
                ['exception' => $e],
            );
            throw $e;
        }
    }
}

$token = new SMARTLaunchToken($puuid);
$token->setIntent(SMARTLaunchToken::INTENT_MAIN_TAB);

echo json_encode([
    'launch' => $token->serialize(),
    'aud' => (new ServerConfig())->getFhirUrl(),
    'patient_uuid' => $puuid,
]);
exit();
