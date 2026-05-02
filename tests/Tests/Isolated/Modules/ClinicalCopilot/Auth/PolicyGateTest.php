<?php

/**
 * Isolated tests for the Agent proxy policy gate.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Auth;

use OpenEMR\Modules\ClinicalCopilot\Auth\AgentRequest;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyDenyReason;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use OpenEMR\Modules\ClinicalCopilot\Auth\SessionContext;
use PHPUnit\Framework\TestCase;

final class PolicyGateTest extends TestCase
{
    private const MODULE_AUTH_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth';

    public static function setUpBeforeClass(): void
    {
        // Module classes aren't on the autoloader's runtime path during
        // isolated tests, so pull them in by hand. PolicyGate has no
        // dependencies on OpenEMR core, so this is sufficient.
        require_once self::MODULE_AUTH_DIR . '/ResolvedFhirUser.php';
        require_once self::MODULE_AUTH_DIR . '/SessionContext.php';
        require_once self::MODULE_AUTH_DIR . '/PolicyDenyReason.php';
        require_once self::MODULE_AUTH_DIR . '/PolicyDecision.php';
        require_once self::MODULE_AUTH_DIR . '/AgentRequest.php';
        require_once self::MODULE_AUTH_DIR . '/PolicyGate.php';
    }

    public function testAllowsBriefingWhenSessionAndPatientMatch(): void
    {
        $gate = new PolicyGate();
        $session = new SessionContext(
            authUserId: '42',
            authUser: 'admin',
            siteId: 'default',
            patientPid: '101',
            fhirUser: new ResolvedFhirUser(
                uuid: 'a8f5f167-f44f-4964-ad62-30e69e7e90d6',
                fhirUserUri: 'https://example.test/apis/default/fhir/Practitioner/a8f5f167-f44f-4964-ad62-30e69e7e90d6',
            ),
        );
        $request = new AgentRequest(
            action: 'briefing',
            siteId: 'default',
            requestedPatientPid: '101',
            requestedScopes: $gate->defaultScopesFor('briefing'),
        );

        $decision = $gate->evaluate($session, $request);

        $this->assertTrue($decision->allowed);
        $this->assertNull($decision->reason);
    }

    public function testDeniesWhenSessionHasNoUser(): void
    {
        $gate = new PolicyGate();
        $session = new SessionContext('', '', 'default', null, null);
        $request = new AgentRequest('echo', 'default', null, []);

        $decision = $gate->evaluate($session, $request);

        $this->assertFalse($decision->allowed);
        $this->assertSame(PolicyDenyReason::MissingSession, $decision->reason);
    }

    public function testDeniesWhenSiteMismatches(): void
    {
        $gate = new PolicyGate();
        $session = new SessionContext('42', 'admin', 'default', '101', $this->stubFhirUser());
        $request = new AgentRequest(
            action: 'briefing',
            siteId: 'tenantb',
            requestedPatientPid: '101',
            requestedScopes: $gate->defaultScopesFor('briefing'),
        );

        $decision = $gate->evaluate($session, $request);

        $this->assertFalse($decision->allowed);
        $this->assertSame(PolicyDenyReason::SiteMismatch, $decision->reason);
    }

    public function testDeniesWhenRequestPatientDiffersFromSessionPatient(): void
    {
        $gate = new PolicyGate();
        $session = new SessionContext('42', 'admin', 'default', '101', $this->stubFhirUser());
        $request = new AgentRequest(
            action: 'briefing',
            siteId: 'default',
            requestedPatientPid: '999',
            requestedScopes: $gate->defaultScopesFor('briefing'),
        );

        $decision = $gate->evaluate($session, $request);

        $this->assertFalse($decision->allowed);
        $this->assertSame(PolicyDenyReason::PatientMismatch, $decision->reason);
    }

    public function testDeniesWhenSessionHasNoPatientButRequestNamesOne(): void
    {
        $gate = new PolicyGate();
        $session = new SessionContext('42', 'admin', 'default', null, $this->stubFhirUser());
        $request = new AgentRequest(
            action: 'briefing',
            siteId: 'default',
            requestedPatientPid: '101',
            requestedScopes: $gate->defaultScopesFor('briefing'),
        );

        $decision = $gate->evaluate($session, $request);

        $this->assertFalse($decision->allowed);
        $this->assertSame(PolicyDenyReason::MissingPatient, $decision->reason);
    }

    public function testDeniesWhenActionIsUnknown(): void
    {
        $gate = new PolicyGate();
        $session = new SessionContext('42', 'admin', 'default', '101', $this->stubFhirUser());
        $request = new AgentRequest('exfiltrate', 'default', '101', []);

        $decision = $gate->evaluate($session, $request);

        $this->assertFalse($decision->allowed);
        $this->assertSame(PolicyDenyReason::UnknownAction, $decision->reason);
    }

    public function testDeniesWhenRequestedScopeNotInActionAllowlist(): void
    {
        $gate = new PolicyGate();
        $session = new SessionContext('42', 'admin', 'default', '101', $this->stubFhirUser());
        $request = new AgentRequest(
            action: 'briefing',
            siteId: 'default',
            requestedPatientPid: '101',
            requestedScopes: ['user/Practitioner.rs'],
        );

        $decision = $gate->evaluate($session, $request);

        $this->assertFalse($decision->allowed);
        $this->assertSame(PolicyDenyReason::ScopeNotPermitted, $decision->reason);
    }

    public function testLatestConversationActionAllowsResumeLookupForActivePatient(): void
    {
        // §4.6 resume lookup. The action is read-only against the agent's
        // own conversation tables — no chart scopes are minted, so the
        // gate's default scope list is `openid` + `fhirUser` only. The
        // patient-match rule still applies because the panel passes a pid.
        $gate = new PolicyGate();
        $session = new SessionContext(
            authUserId: '42',
            authUser: 'admin',
            siteId: 'default',
            patientPid: '101',
            fhirUser: $this->stubFhirUser(),
        );
        $request = new AgentRequest(
            action: 'latest_conversation',
            siteId: 'default',
            requestedPatientPid: '101',
            requestedScopes: $gate->defaultScopesFor('latest_conversation'),
        );

        $decision = $gate->evaluate($session, $request);

        $this->assertTrue($decision->allowed);
        $this->assertSame(['openid', 'fhirUser'], $gate->defaultScopesFor('latest_conversation'));
    }

    public function testConversationHistoryActionAllowsListLookupForActivePatient(): void
    {
        // §4.7 history sidebar feed: same shape as latest_conversation
        // — read-only over the agent's own conversation tables, no
        // chart scopes minted, patient-match required.
        $gate = new PolicyGate();
        $session = new SessionContext(
            authUserId: '42',
            authUser: 'admin',
            siteId: 'default',
            patientPid: '101',
            fhirUser: $this->stubFhirUser(),
        );
        $request = new AgentRequest(
            action: 'conversation_history',
            siteId: 'default',
            requestedPatientPid: '101',
            requestedScopes: $gate->defaultScopesFor('conversation_history'),
        );

        $decision = $gate->evaluate($session, $request);

        $this->assertTrue($decision->allowed);
        $this->assertSame(['openid', 'fhirUser'], $gate->defaultScopesFor('conversation_history'));
    }

    public function testConversationHistoryDeniesAcrossPatients(): void
    {
        $gate = new PolicyGate();
        $session = new SessionContext('42', 'admin', 'default', '101', $this->stubFhirUser());
        $request = new AgentRequest(
            action: 'conversation_history',
            siteId: 'default',
            requestedPatientPid: '999',
            requestedScopes: $gate->defaultScopesFor('conversation_history'),
        );

        $decision = $gate->evaluate($session, $request);

        $this->assertFalse($decision->allowed);
        $this->assertSame(PolicyDenyReason::PatientMismatch, $decision->reason);
    }

    public function testLatestConversationDeniesAcrossPatients(): void
    {
        $gate = new PolicyGate();
        $session = new SessionContext('42', 'admin', 'default', '101', $this->stubFhirUser());
        $request = new AgentRequest(
            action: 'latest_conversation',
            siteId: 'default',
            requestedPatientPid: '999',
            requestedScopes: $gate->defaultScopesFor('latest_conversation'),
        );

        $decision = $gate->evaluate($session, $request);

        $this->assertFalse($decision->allowed);
        $this->assertSame(PolicyDenyReason::PatientMismatch, $decision->reason);
    }

    public function testEchoActionRequiresSessionButNoPatientOrScopes(): void
    {
        $gate = new PolicyGate();
        $session = new SessionContext(
            authUserId: '42',
            authUser: 'admin',
            siteId: 'default',
            patientPid: null,
            fhirUser: $this->stubFhirUser(),
        );
        $request = new AgentRequest('echo', 'default', null, []);

        $decision = $gate->evaluate($session, $request);

        $this->assertTrue($decision->allowed);
    }

    public function testDeniesWhenFhirUserUnresolved(): void
    {
        $gate = new PolicyGate();
        // authUserId is present but fhirUser is null — i.e. the session
        // user could not be mapped to a Practitioner. Must fail closed.
        $session = new SessionContext('42', 'admin', 'default', null, null);
        $request = new AgentRequest('echo', 'default', null, []);

        $decision = $gate->evaluate($session, $request);

        $this->assertFalse($decision->allowed);
        $this->assertSame(PolicyDenyReason::MissingSession, $decision->reason);
    }

    public function testBriefingMintsScopesForEveryDataCategory(): void
    {
        // Regression: when a new DataCategory case is added (the §4.6.3
        // reminder + §4.6.4 medication_statement work both did this), the
        // briefing allowlist must mint the matching SMART scope or the
        // agent's snapshot callback will be rejected by
        // AgentSnapshotController with `scope_not_permitted`. Loop the
        // enum so adding a category without updating PolicyGate fails
        // here instead of in production.
        require_once self::MODULE_AUTH_DIR . '/../Snapshot/DataCategory.php';

        $briefingScopes = (new PolicyGate())->defaultScopesFor('briefing');
        foreach (\OpenEMR\Modules\ClinicalCopilot\Snapshot\DataCategory::cases() as $category) {
            self::assertContains(
                $category->smartScope(),
                $briefingScopes,
                "Briefing's allowlist is missing the SMART scope for "
                . "DataCategory::{$category->name} ({$category->smartScope()}). "
                . "Add it to PolicyGate::ACTION_SCOPE_ALLOWLIST['briefing'] "
                . "or AgentSnapshotController will reject the snapshot "
                . "callback with scope_not_permitted.",
            );
        }
    }

    private function stubFhirUser(): ResolvedFhirUser
    {
        return new ResolvedFhirUser(
            uuid: 'a8f5f167-f44f-4964-ad62-30e69e7e90d6',
            fhirUserUri: 'https://example.test/apis/default/fhir/Practitioner/a8f5f167-f44f-4964-ad62-30e69e7e90d6',
        );
    }
}
