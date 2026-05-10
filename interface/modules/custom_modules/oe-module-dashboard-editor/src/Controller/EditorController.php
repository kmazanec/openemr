<?php

/**
 * Dashboard Editor Controller.
 *
 * Routes the dashboard SPA's in-page edit/add modals into the
 * existing OpenEMR Service classes (AllergyIntoleranceService,
 * ConditionService, PrescriptionService, VitalsService, etc.). Reads
 * still flow through the FHIR layer; this controller exists for the
 * writes the FHIR routes don't expose.
 *
 * Auth: relies on the OpenEMR session cookie that's already present
 * when the SPA is hosted inside `main_v2.php`. Every action checks a
 * CSRF token to defeat cross-site post-back and an authenticated
 * user. ACL checks reuse OpenEMR's `AclMain::aclCheckCore('patients',
 * 'med')` per the legacy edit pages.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\DashboardEditor\Controller;

use InvalidArgumentException;
use OpenEMR\BC\ServiceContainer;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Csrf\CsrfUtils;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Services\AllergyIntoleranceService;
use OpenEMR\Services\CareTeamService;
use OpenEMR\Services\ConditionService;
use OpenEMR\Services\MedicationPatientIssueService;
use OpenEMR\Services\PrescriptionService;
use OpenEMR\Services\VitalsService;
use RuntimeException;
use Symfony\Component\HttpFoundation\Request;

final readonly class EditorController
{
    private int $userId;
    private string $sessionUser;
    private Request $request;

    public function __construct()
    {
        $session = SessionWrapperFactory::getInstance()->getActiveSession();
        $authUserId = $session->get('authUserID');
        $this->userId = is_int($authUserId) ? $authUserId : (is_numeric($authUserId) ? (int) $authUserId : 0);
        $authUser = $session->get('authUser');
        $this->sessionUser = is_string($authUser) ? $authUser : '';
        $this->request = Request::createFromGlobals();
    }

    public function handleRequest(): void
    {
        header('Content-Type: application/json');

        $body = $this->readJsonBody();
        $action = $this->stringFrom($body, 'action');
        if ($action === '') {
            $action = (string) $this->request->query->get('action', '');
        }

        $csrf = $this->stringFrom($body, 'csrf_token');
        if ($csrf === '') {
            $csrf = (string) $this->request->request->get('csrf_token', $this->request->query->get('csrf_token', ''));
        }
        $session = SessionWrapperFactory::getInstance()->getActiveSession();
        if (!CsrfUtils::verifyCsrfToken($csrf, session: $session)) {
            $this->sendError('csrf_failed', 403);
            return;
        }
        if ($this->userId <= 0) {
            $this->sendError('not_authenticated', 401);
            return;
        }

        try {
            match ($action) {
                'save_allergy'        => $this->saveAllergy($body),
                'delete_allergy'      => $this->deleteAllergy($body),
                'save_problem'        => $this->saveProblem($body),
                'delete_problem'      => $this->deleteProblem($body),
                'save_medication'     => $this->saveMedication($body),
                'delete_medication'   => $this->deleteMedication($body),
                'save_prescription'   => $this->savePrescription($body),
                'delete_prescription' => $this->deletePrescription($body),
                'save_lab_result'     => $this->saveLabResult($body),
                'save_vitals'         => $this->saveVitals($body),
                'save_care_team'      => $this->saveCareTeam($body),
                default               => $this->sendError('unknown_action'),
            };
        } catch (InvalidArgumentException $e) {
            ServiceContainer::getLogger()->warning('dashboard-editor invalid input', ['exception' => $e]);
            $this->sendError('invalid_input');
        } catch (RuntimeException $e) {
            ServiceContainer::getLogger()->error('dashboard-editor server error', ['exception' => $e]);
            $this->sendError('server_error', 500);
        }
    }

    // ─────────────────────────── Allergies ───────────────────────────

    /** @param array<string, mixed> $body */
    private function saveAllergy(array $body): void
    {
        $this->requireAcl('patients', 'med');
        $puuid = $this->stringFrom($body, 'puuid');
        if ($puuid === '') {
            $this->sendError('missing_puuid');
            return;
        }
        $payload = [
            'puuid'        => $puuid,
            'title'        => $this->stringFrom($body, 'title'),
            'reaction'     => $this->nullableStringFrom($body, 'reaction'),
            'severity_al'  => $this->nullableStringFrom($body, 'severity'),
            'verification' => $this->nullableStringFrom($body, 'verification') ?? 'confirmed',
            'begdate'      => $this->nullableStringFrom($body, 'begdate'),
            'enddate'      => $this->nullableStringFrom($body, 'enddate'),
            'comments'     => $this->nullableStringFrom($body, 'comments'),
        ];
        $svc = new AllergyIntoleranceService();
        $uuid = $this->nullableStringFrom($body, 'uuid');
        $result = ($uuid === null || $uuid === '')
            ? $svc->insert($payload)
            : $svc->update($uuid, $payload);
        $this->respondFromProcessingResult($result);
    }

    /** @param array<string, mixed> $body */
    private function deleteAllergy(array $body): void
    {
        $this->requireAcl('patients', 'med');
        $puuid = $this->stringFrom($body, 'puuid');
        $uuid  = $this->stringFrom($body, 'uuid');
        if ($puuid === '' || $uuid === '') {
            $this->sendError('missing_uuid');
            return;
        }
        $result = (new AllergyIntoleranceService())->delete($puuid, $uuid);
        $this->respondFromProcessingResult($result);
    }

    // ───────────────────────── Medical Problems ─────────────────────────

    /** @param array<string, mixed> $body */
    private function saveProblem(array $body): void
    {
        $this->requireAcl('patients', 'med');
        $puuid = $this->stringFrom($body, 'puuid');
        $title = $this->stringFrom($body, 'title');
        if ($puuid === '' || $title === '') {
            $this->sendError('missing_field');
            return;
        }
        $payload = [
            'puuid'        => $puuid,
            'title'        => $title,
            'diagnosis'    => $this->nullableStringFrom($body, 'diagnosis'),
            'verification' => $this->nullableStringFrom($body, 'verification') ?? 'confirmed',
            'begdate'      => $this->nullableStringFrom($body, 'begdate'),
            'enddate'      => $this->nullableStringFrom($body, 'enddate'),
            'comments'     => $this->nullableStringFrom($body, 'comments'),
        ];
        $svc = new ConditionService();
        $uuid = $this->nullableStringFrom($body, 'uuid');
        $result = ($uuid === null || $uuid === '')
            ? $svc->insert($payload)
            : $svc->update($uuid, $payload);
        $this->respondFromProcessingResult($result);
    }

    /** @param array<string, mixed> $body */
    private function deleteProblem(array $body): void
    {
        $this->requireAcl('patients', 'med');
        $puuid = $this->stringFrom($body, 'puuid');
        $uuid  = $this->stringFrom($body, 'uuid');
        if ($puuid === '' || $uuid === '') {
            $this->sendError('missing_uuid');
            return;
        }
        $result = (new ConditionService())->delete($puuid, $uuid);
        $this->respondFromProcessingResult($result);
    }

    // ─────────────────────────── Medications ───────────────────────────
    //
    // The dashboard's MedicationsCard reads `MedicationRequest?intent=plan`,
    // which surfaces rows from `lists` (type='medication') joined with
    // `lists_medication`. The legacy add/edit form is `add_edit_issue.php`
    // with `?type=medication`. There's no FHIR write route, so we
    // bridge through `lists` directly.

    /** @param array<string, mixed> $body */
    private function saveMedication(array $body): void
    {
        $this->requireAcl('patients', 'med');
        $puuid = $this->stringFrom($body, 'puuid');
        $title = $this->stringFrom($body, 'title');
        if ($puuid === '' || $title === '') {
            $this->sendError('missing_field');
            return;
        }
        $pid = $this->pidFromPuuid($puuid);
        if ($pid === null) {
            $this->sendError('unknown_patient');
            return;
        }

        $listIdRaw = $body['id'] ?? 0;
        $listId = is_int($listIdRaw) ? $listIdRaw : (is_numeric($listIdRaw) ? (int) $listIdRaw : 0);
        $listUuid = $this->nullableStringFrom($body, 'uuid');
        if ($listId === 0 && $listUuid !== null && $listUuid !== '') {
            try {
                $bytes = UuidRegistry::uuidToBytes($listUuid);
                $row = QueryUtils::querySingleRow(
                    "SELECT id FROM lists WHERE uuid = ? AND pid = ? AND type = 'medication'",
                    [$bytes, $pid],
                );
                if (is_array($row) && isset($row['id'])) {
                    $idVal = $row['id'];
                    $listId = is_int($idVal) ? $idVal : (is_numeric($idVal) ? (int) $idVal : 0);
                }
            } catch (InvalidArgumentException) {
                // Fall through and insert a new row.
            }
        }
        $now = date('Y-m-d');
        $beg = $this->nullableStringFrom($body, 'begdate') ?? $now;
        $end = $this->nullableStringFrom($body, 'enddate');
        $comments = $this->nullableStringFrom($body, 'comments') ?? '';

        if ($listId > 0) {
            QueryUtils::sqlStatementThrowException(
                "UPDATE lists SET title=?, begdate=?, enddate=?, comments=?, modifydate=NOW() "
                . "WHERE id=? AND pid=? AND type='medication'",
                [$title, $beg, $end, $comments, $listId, $pid],
            );
            $newId = $listId;
        } else {
            $newId = (int) QueryUtils::sqlInsert(
                "INSERT INTO lists (date, type, activity, pid, user, title, begdate, enddate, comments, modifydate) "
                . "VALUES (NOW(), 'medication', 1, ?, ?, ?, ?, ?, ?, NOW())",
                [
                    $pid,
                    $this->sessionUser,
                    $title,
                    $beg,
                    $end,
                    $comments,
                ],
            );
        }

        $svc = new MedicationPatientIssueService();
        $existing = QueryUtils::querySingleRow(
            "SELECT id FROM lists_medication WHERE list_id = ?",
            [$newId],
        );
        $record = [
            'list_id'        => $newId,
            'request_intent' => $this->nullableStringFrom($body, 'request_intent') ?? 'plan',
            'usage_category' => $this->nullableStringFrom($body, 'usage_category') ?? 'outpatient',
        ];
        if (is_array($existing) && isset($existing['id'])) {
            $existingIdVal = $existing['id'];
            $record['id'] = is_int($existingIdVal)
                ? $existingIdVal
                : (is_numeric($existingIdVal) ? (int) $existingIdVal : 0);
            $svc->updateIssue($record);
        } else {
            $svc->createIssue($record);
        }

        $row = QueryUtils::querySingleRow("SELECT uuid FROM lists WHERE id = ?", [$newId]);
        $uuidStr = null;
        if (is_array($row) && isset($row['uuid']) && is_string($row['uuid']) && $row['uuid'] !== '') {
            $uuidStr = UuidRegistry::uuidToString($row['uuid']);
        } else {
            $bytes = (new UuidRegistry(['table_name' => 'lists']))->createUuid();
            QueryUtils::sqlStatementThrowException(
                "UPDATE lists SET uuid = ? WHERE id = ?",
                [$bytes, $newId],
            );
            $uuidStr = UuidRegistry::uuidToString($bytes);
        }
        $this->sendOk(['id' => $newId, 'uuid' => $uuidStr]);
    }

    /** @param array<string, mixed> $body */
    private function deleteMedication(array $body): void
    {
        $this->requireAcl('patients', 'med');
        $puuid = $this->stringFrom($body, 'puuid');
        $listIdRaw = $body['id'] ?? 0;
        $listId = is_int($listIdRaw) ? $listIdRaw : (is_numeric($listIdRaw) ? (int) $listIdRaw : 0);
        if ($puuid === '' || $listId <= 0) {
            $this->sendError('missing_field');
            return;
        }
        $pid = $this->pidFromPuuid($puuid);
        if ($pid === null) {
            $this->sendError('unknown_patient');
            return;
        }
        QueryUtils::sqlStatementThrowException(
            "DELETE FROM lists_medication WHERE list_id = ?",
            [$listId],
        );
        QueryUtils::sqlStatementThrowException(
            "DELETE FROM lists WHERE id = ? AND pid = ? AND type = 'medication'",
            [$listId, $pid],
        );
        $this->sendOk(['id' => $listId]);
    }

    // ─────────────────────────── Prescriptions ───────────────────────────

    /** @param array<string, mixed> $body */
    private function savePrescription(array $body): void
    {
        $this->requireAcl('patients', 'rx');
        $puuid = $this->stringFrom($body, 'puuid');
        $drug  = $this->stringFrom($body, 'drug');
        if ($puuid === '' || $drug === '') {
            $this->sendError('missing_field');
            return;
        }
        $pid = $this->pidFromPuuid($puuid);
        if ($pid === null) {
            $this->sendError('unknown_patient');
            return;
        }

        $payload = [
            'drug'                     => $drug,
            'patient_id'               => $pid,
            'dosage'                   => $this->nullableStringFrom($body, 'dosage'),
            'quantity'                 => $this->nullableStringFrom($body, 'quantity'),
            'size'                     => $this->nullableStringFrom($body, 'size'),
            'unit'                     => $this->nullableStringFrom($body, 'unit'),
            'note'                     => $this->nullableStringFrom($body, 'note'),
            'route'                    => $this->nullableStringFrom($body, 'route'),
            'interval'                 => $this->nullableStringFrom($body, 'interval'),
            'rxnorm_drugcode'          => $this->nullableStringFrom($body, 'rxnorm_drugcode'),
            'drug_dosage_instructions' => $this->nullableStringFrom($body, 'instructions'),
            'date_added'               => $this->nullableStringFrom($body, 'date_added') ?? date('Y-m-d'),
            'active'                   => 1,
        ];
        $result = (new PrescriptionService())->insert($payload);
        $this->respondFromProcessingResult($result);
    }

    /** @param array<string, mixed> $body */
    private function deletePrescription(array $body): void
    {
        $this->requireAcl('patients', 'rx');
        $uuid = $this->stringFrom($body, 'uuid');
        if ($uuid === '') {
            $this->sendError('missing_uuid');
            return;
        }
        $result = (new PrescriptionService())->delete($uuid);
        $this->respondFromProcessingResult($result);
    }

    // ─────────────────────────── Lab results ───────────────────────────

    /** @param array<string, mixed> $body */
    private function saveLabResult(array $body): void
    {
        $this->requireAcl('patients', 'lab');
        $reportIdRaw = $body['report_id'] ?? 0;
        $reportId = is_int($reportIdRaw) ? $reportIdRaw : (is_numeric($reportIdRaw) ? (int) $reportIdRaw : 0);
        $resultCode = $this->stringFrom($body, 'result_code');
        $resultValue = $this->stringFrom($body, 'result');
        if ($reportId <= 0 || $resultCode === '') {
            $this->sendError('missing_field');
            return;
        }
        $row = [
            'procedure_report_id' => $reportId,
            'result_code'         => $resultCode,
            'result_text'         => $this->nullableStringFrom($body, 'result_text') ?? '',
            'date'                => $this->nullableStringFrom($body, 'date') ?? date('Y-m-d H:i:s'),
            'facility'            => $this->nullableStringFrom($body, 'facility') ?? '',
            'units'               => $this->nullableStringFrom($body, 'units') ?? '',
            'result'              => $resultValue,
            'range'               => $this->nullableStringFrom($body, 'range') ?? '',
            'abnormal'            => $this->nullableStringFrom($body, 'abnormal') ?? 'no',
            'comments'            => $this->nullableStringFrom($body, 'comments') ?? '',
            'result_status'       => $this->nullableStringFrom($body, 'result_status') ?? 'final',
        ];
        $resultIdRaw = $body['result_id'] ?? 0;
        $resultId = is_int($resultIdRaw) ? $resultIdRaw : (is_numeric($resultIdRaw) ? (int) $resultIdRaw : 0);
        if ($resultId > 0) {
            $cols = [];
            $bind = [];
            foreach ($row as $k => $v) {
                $cols[] = "`$k` = ?";
                $bind[] = $v;
            }
            $bind[] = $resultId;
            QueryUtils::sqlStatementThrowException(
                "UPDATE procedure_result SET " . implode(', ', $cols) . " WHERE procedure_result_id = ?",
                $bind,
            );
            $this->sendOk(['procedure_result_id' => $resultId]);
            return;
        }
        $cols = [];
        $marks = [];
        $bind = [];
        foreach ($row as $k => $v) {
            $cols[] = "`$k`";
            $marks[] = '?';
            $bind[] = $v;
        }
        $newId = (int) QueryUtils::sqlInsert(
            "INSERT INTO procedure_result (" . implode(', ', $cols) . ") VALUES (" . implode(', ', $marks) . ")",
            $bind,
        );
        $this->sendOk(['procedure_result_id' => $newId]);
    }

    // ─────────────────────────── Vitals ───────────────────────────

    /** @param array<string, mixed> $body */
    private function saveVitals(array $body): void
    {
        $this->requireAcl('patients', 'med');
        $puuid = $this->stringFrom($body, 'puuid');
        if ($puuid === '') {
            $this->sendError('missing_puuid');
            return;
        }
        $pid = $this->pidFromPuuid($puuid);
        if ($pid === null) {
            $this->sendError('unknown_patient');
            return;
        }

        $allowed = [
            'bps', 'bpd', 'pulse', 'respiration', 'temperature', 'temp_method',
            'weight', 'height', 'BMI', 'BMI_status', 'oxygen_saturation',
            'oxygen_flow_rate', 'inhaled_oxygen_concentration', 'waist_circ',
            'head_circ', 'note',
        ];
        $vitals = ['pid' => $pid];
        foreach ($allowed as $key) {
            if (array_key_exists($key, $body) && $body[$key] !== '' && $body[$key] !== null) {
                $vitals[$key] = $body[$key];
            }
        }
        if (isset($body['id'])) {
            $idRaw = $body['id'];
            $idVal = is_int($idRaw) ? $idRaw : (is_numeric($idRaw) ? (int) $idRaw : 0);
            if ($idVal > 0) {
                $vitals['id'] = $idVal;
            }
        }
        $vitals['authorized'] = $this->userId;

        $svc = new VitalsService();
        $saved = $svc->save($vitals);
        $this->sendOk(['saved' => $saved]);
    }

    // ─────────────────────────── Care team ───────────────────────────

    /** @param array<string, mixed> $body */
    private function saveCareTeam(array $body): void
    {
        $this->requireAcl('patients', 'demo');
        $puuid = $this->stringFrom($body, 'puuid');
        if ($puuid === '') {
            $this->sendError('missing_puuid');
            return;
        }
        $pid = $this->pidFromPuuid($puuid);
        if ($pid === null) {
            $this->sendError('unknown_patient');
            return;
        }
        $teamRaw = $body['team'] ?? [];
        if (!is_array($teamRaw)) {
            $this->sendError('invalid_team');
            return;
        }
        $name = $this->nullableStringFrom($body, 'team_name') ?? 'Care Team';
        $teamId = null;
        if (isset($body['team_id'])) {
            $teamIdRaw = $body['team_id'];
            $teamId = is_int($teamIdRaw)
                ? $teamIdRaw
                : (is_numeric($teamIdRaw) ? (int) $teamIdRaw : null);
        }

        $svc = new CareTeamService();
        $svc->saveCareTeam($pid, $teamId, $name, $teamRaw, 'active');
        $this->sendOk(['ok' => true]);
    }

    // ─────────────────────────── Helpers ───────────────────────────

    /** @return array<string, mixed> */
    private function readJsonBody(): array
    {
        $raw = $this->request->getContent();
        if ($raw === '') {
            return [];
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            return [];
        }
        $out = [];
        foreach ($decoded as $k => $v) {
            if (is_string($k)) {
                $out[$k] = $v;
            }
        }
        return $out;
    }

    /** @param array<string, mixed> $body */
    private function stringFrom(array $body, string $key): string
    {
        if (!isset($body[$key])) return '';
        $v = $body[$key];
        if (!is_string($v) && !is_int($v) && !is_float($v)) return '';
        return trim((string) $v);
    }

    /** @param array<string, mixed> $body */
    private function nullableStringFrom(array $body, string $key): ?string
    {
        if (!isset($body[$key])) return null;
        $v = $body[$key];
        if (!is_string($v) && !is_int($v) && !is_float($v)) return null;
        $trimmed = trim((string) $v);
        return $trimmed === '' ? null : $trimmed;
    }

    private function requireAcl(string $section, string $value): void
    {
        if (AclMain::aclCheckCore($section, $value) !== true) {
            $this->sendError('acl_denied', 403);
            exit;
        }
    }

    private function pidFromPuuid(string $puuid): ?int
    {
        try {
            $bytes = UuidRegistry::uuidToBytes($puuid);
        } catch (InvalidArgumentException) {
            return null;
        }
        $row = QueryUtils::querySingleRow("SELECT pid FROM patient_data WHERE uuid = ?", [$bytes]);
        if (!is_array($row) || !isset($row['pid'])) return null;
        $pid = $row['pid'];
        if (is_int($pid)) return $pid;
        if (is_numeric($pid)) return (int) $pid;
        return null;
    }

    private function respondFromProcessingResult(mixed $result): void
    {
        if (!is_object($result)) {
            $this->sendOk(['result' => $result]);
            return;
        }
        if (method_exists($result, 'isValid') && $result->isValid() === false) {
            $messages = method_exists($result, 'getValidationMessages') ? $result->getValidationMessages() : [];
            $this->sendError('validation_failed', 400, ['messages' => $messages]);
            return;
        }
        $data = method_exists($result, 'getData') ? $result->getData() : null;
        $this->sendOk(['data' => $data]);
    }

    /** @param array<string, mixed> $payload */
    private function sendOk(array $payload): void
    {
        http_response_code(200);
        $body = array_merge(['ok' => true], $payload);
        echo (string) json_encode($body);
    }

    /** @param array<string, mixed> $extra */
    private function sendError(string $code, int $status = 400, array $extra = []): void
    {
        http_response_code($status);
        $body = array_merge(['ok' => false, 'error' => $code], $extra);
        echo (string) json_encode($body);
    }
}
