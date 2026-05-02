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
