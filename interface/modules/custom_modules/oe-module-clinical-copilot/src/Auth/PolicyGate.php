<?php

/**
 * Pure policy gate for Agent proxy requests.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

/**
 * Site/patient/scope policy check, run before any token mint or upstream call.
 *
 * The gate is intentionally pure: pass in the session context and the
 * requested action, get back an Allow or a typed Deny. No DB, no
 * superglobals, no logging side effects. Logging and HTTP responses are the
 * controller's job; this just answers the question.
 *
 * Three checks, in order:
 *   1. Session must carry an authenticated user.
 *   2. The requested site must match the session's site (defense in depth —
 *      OpenEMR also enforces this at the session layer, but a stale URL or a
 *      bug in the proxy could otherwise smuggle a request to the wrong site).
 *   3. If the request names a patient, it must match the session's pid; UC5
 *      whole-day routes pass a null patient and skip this rule.
 *   4. Every requested scope must be in the per-action allowlist; an unknown
 *      action denies fast.
 */
final readonly class PolicyGate
{
    /**
     * Per-action allowlist of SMART scopes the proxy is willing to mint.
     *
     * Phase 1.4 ships `echo` (the smoke-test action — no real scopes needed)
     * and the Phase 3 `briefing` action. As later UCs land they extend this
     * map; the gate denies any action not listed here.
     *
     * @var array<string, list<string>>
     */
    private const ACTION_SCOPE_ALLOWLIST = [
        'echo' => [],
        'briefing' => [
            'openid',
            'fhirUser',
            'api:fhir',
            'user/Patient.rs',
            'user/Condition.rs',
            'user/AllergyIntolerance.rs',
            'user/Observation.rs',
            'user/MedicationRequest.rs',
            'user/Encounter.rs',
            'user/Appointment.rs',
            // §4.6.3 reminders snapshot field — guarded by Task.rs in
            // AgentSnapshotController via DataCategory::Reminder.
            'user/Task.rs',
            // §4.6.4 patient-reported medications snapshot field —
            // guarded by MedicationStatement.rs.
            'user/MedicationStatement.rs',
            // Supervisor-driven panel uploads: when the envelope carries
            // pendingUploads the supervisor picks `kickoffExtraction`,
            // which runs the full ingestion pipeline inside the
            // briefing turn and ends with a Tier-1 DocumentReference
            // write back to OpenEMR. Without this scope the Tier-1
            // callback sees `scope_not_permitted` and the persist node
            // emits pipeline.error{code: persist_failed}. Mirrors the
            // `extract` action's scope set; safe to include unconditionally
            // because the Tier-1 endpoint only writes when the supervisor
            // chose to extract — a no-doc briefing never reaches the
            // callback.
            'user/DocumentReference.cs',
            // Chart-side document discovery: the agent's
            // `getChartDocuments` tool calls
            // `public/snapshot/chart-documents.php` on every briefing
            // so it can detect documents the clinician uploaded
            // through OpenEMR's legacy Documents UI (rather than
            // through the chat panel) and route them through the same
            // `kickoffExtraction` path. Read-only — the snapshot
            // endpoint never writes.
            'user/DocumentReference.rs',
        ],
        // §4.6 resume lookup: read-only JSON, no chart access. The
        // agent reads its own conversation tables; no SMART scopes
        // are needed because the action does not touch FHIR resources.
        // We still mint a token (the agent gates on principal.sub for
        // user scoping), but with no chart scopes attached.
        'latest_conversation' => [
            'openid',
            'fhirUser',
        ],
        // §4.7 history sidebar feed: same shape as latest_conversation
        // — read-only against the agent's own conversation tables,
        // user-scoped server-side via principal.sub.
        'conversation_history' => [
            'openid',
            'fhirUser',
        ],
        // §5.4 schedule-view annotations: read-only against the
        // agent's `schedule_briefings` cache, self-only on the agent
        // side (principal.sub must equal practitioner_uuid). No chart
        // scopes — the precomputed rows already exist; this read does
        // not access FHIR resources.
        'schedule_briefings' => [
            'openid',
            'fhirUser',
        ],
        // §B.8 ingestion-pipeline trigger (path A — panel upload during
        // a conversation). The agent invokes the full pipeline with this
        // token: rasterize/vision/schemaValidate use no chart scopes;
        // patientMatch + emitDeltas read demographics, allergies,
        // medications and conditions through the snapshot endpoint;
        // persist writes a DocumentReference back. Scopes mirror
        // briefing's read set plus the DocumentReference write scope.
        'extract' => [
            'openid',
            'fhirUser',
            'api:fhir',
            'user/Patient.rs',
            'user/Condition.rs',
            'user/AllergyIntolerance.rs',
            'user/Observation.rs',
            'user/MedicationRequest.rs',
            'user/Encounter.rs',
            'user/MedicationStatement.rs',
            'user/DocumentReference.cs',
        ],
        // F.5a panel-side accept-fact click. Routes through the agent
        // middleman at `/v1/agent/accept_fact`, which reads the
        // extracted artifact, materializes the per-type promotion
        // body, and forwards to `promote.php` with this same token.
        // Scope set is the union of every Tier-3 write surface F.5a–F.5e
        // will exercise: lab + the four list-shaped fact types. Holding
        // the union here (rather than a per-fact-type narrow allowlist)
        // keeps the panel from having to round-trip the type to the
        // proxy before clicking accept; the agent middleman is the
        // type-aware policy point and rejects mismatches there.
        // F.5b–F.5e flip each non-lab branch from 501 to a real write.
        // F.5e adds `user/FamilyMemberHistory.cs` so a `Condition`
        // token (which the past-medical-history branch will require
        // once F.5d lands) cannot smuggle through and write a
        // family-history row, and vice-versa.
        // F.6 adds `user/Patient.cs` for demographics-delta promotion
        // (address/phone/email writes through OpenEMR's standard
        // `PatientService::databaseUpdate()` path).
        'accept_fact' => [
            'openid',
            'fhirUser',
            'api:fhir',
            'user/DiagnosticReport.cs',
            'user/AllergyIntolerance.cs',
            'user/MedicationStatement.cs',
            'user/Condition.cs',
            'user/FamilyMemberHistory.cs',
            'user/Patient.cs',
        ],
    ];

    public function evaluate(SessionContext $session, AgentRequest $request): PolicyDecision
    {
        if ($session->authUserId === '' || $session->authUser === '') {
            return PolicyDecision::deny(
                PolicyDenyReason::MissingSession,
                'No authenticated OpenEMR user in session',
            );
        }

        // The proxy must have resolved the session user to a Practitioner
        // fhirUser before reaching the gate. A null here means the session
        // user is not a staff/system user, or their `users.uuid` row could
        // not be read — either way the agent would receive a token with no
        // verifiable identity, so fail closed.
        if ($session->fhirUser === null) {
            return PolicyDecision::deny(
                PolicyDenyReason::MissingSession,
                'Session user could not be resolved to a Practitioner identity',
            );
        }

        if ($session->siteId !== $request->siteId) {
            return PolicyDecision::deny(
                PolicyDenyReason::SiteMismatch,
                'Request site does not match session site',
            );
        }

        $allowedScopes = self::ACTION_SCOPE_ALLOWLIST[$request->action] ?? null;
        if ($allowedScopes === null) {
            return PolicyDecision::deny(
                PolicyDenyReason::UnknownAction,
                'Action is not registered with the proxy',
            );
        }

        if ($request->requestedPatientPid !== null) {
            if ($session->patientPid === null) {
                return PolicyDecision::deny(
                    PolicyDenyReason::MissingPatient,
                    'Request names a patient but session has no patient context',
                );
            }
            if ($session->patientPid !== $request->requestedPatientPid) {
                return PolicyDecision::deny(
                    PolicyDenyReason::PatientMismatch,
                    'Request patient does not match session patient',
                );
            }
        }

        foreach ($request->requestedScopes as $scope) {
            if (!in_array($scope, $allowedScopes, strict: true)) {
                return PolicyDecision::deny(
                    PolicyDenyReason::ScopeNotPermitted,
                    'Requested scope is not permitted for this action',
                );
            }
        }

        return PolicyDecision::allow();
    }

    /**
     * @return list<string>
     */
    public function defaultScopesFor(string $action): array
    {
        return self::ACTION_SCOPE_ALLOWLIST[$action] ?? [];
    }
}
