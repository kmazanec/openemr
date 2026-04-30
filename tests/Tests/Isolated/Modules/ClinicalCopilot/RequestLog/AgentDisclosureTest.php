<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\RequestLog;

use DateTimeImmutable;
use DateTimeZone;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

final class AgentDisclosureTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/RequestLog';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_DIR . '/AgentDisclosure.php';
    }

    public function testDisclosureIsFinalAndReadonly(): void
    {
        $r = new ReflectionClass(AgentDisclosure::class);
        self::assertTrue($r->isFinal(), 'AgentDisclosure must be final');
        self::assertTrue($r->isReadOnly(), 'AgentDisclosure must be readonly');
    }

    public function testDisclosureHoldsDeclaredFields(): void
    {
        $when = new DateTimeImmutable('2026-04-30T15:00:00+00:00');

        $d = new AgentDisclosure(
            disclosedAt: $when,
            actorUserId: 7,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/abc',
            siteId: 'default',
            patientPid: 42,
            patientUuid: 'aabb',
            conversationId: 'conv-xyz',
            action: 'briefing',
            requestId: 'jti-1234567890abcdef',
            categories: ['allergy', 'diagnosis', 'medication'],
            destination: 'openemr-clinical-copilot-agent',
        );

        self::assertSame($when, $d->disclosedAt);
        self::assertSame(7, $d->actorUserId);
        self::assertSame('https://emr.example/oauth2/default/Practitioner/abc', $d->actorFhirUser);
        self::assertSame('default', $d->siteId);
        self::assertSame(42, $d->patientPid);
        self::assertSame('aabb', $d->patientUuid);
        self::assertSame('conv-xyz', $d->conversationId);
        self::assertSame('briefing', $d->action);
        self::assertSame('jti-1234567890abcdef', $d->requestId);
        self::assertSame(['allergy', 'diagnosis', 'medication'], $d->categories);
        self::assertSame('openemr-clinical-copilot-agent', $d->destination);
    }

    public function testNullablePatientUuidAndConversationIdSupported(): void
    {
        // patient_uuid may be unknown when called outside the standard flow;
        // conversation_id is null until Phase 3.5 wires conversation rows.
        $d = new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('now', new DateTimeZone('UTC')),
            actorUserId: 1,
            actorFhirUser: 'https://emr.example/oauth2/default/Person/u',
            siteId: 'default',
            patientPid: 99,
            patientUuid: null,
            conversationId: null,
            action: 'echo',
            requestId: 'jti-deadbeef',
            categories: [],
            destination: 'openemr-clinical-copilot-agent',
        );

        self::assertNull($d->patientUuid);
        self::assertNull($d->conversationId);
        self::assertSame([], $d->categories);
    }

    public function testCategoriesAreSortedAtConstruction(): void
    {
        $d = new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('2026-04-30T00:00:00+00:00'),
            actorUserId: 1,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/x',
            siteId: 'default',
            patientPid: 1,
            patientUuid: null,
            conversationId: null,
            action: 'briefing',
            requestId: 'jti-1',
            categories: ['medication', 'allergy', 'diagnosis'],
            destination: 'openemr-clinical-copilot-agent',
        );

        self::assertSame(['allergy', 'diagnosis', 'medication'], $d->categories);
    }

    public function testDisclosureRejectsEmptyActionAndRequestId(): void
    {
        $this->expectException(\DomainException::class);

        new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('2026-04-30T00:00:00+00:00'),
            actorUserId: 1,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/x',
            siteId: 'default',
            patientPid: 1,
            patientUuid: null,
            conversationId: null,
            action: '',
            requestId: 'jti-1',
            categories: [],
            destination: 'openemr-clinical-copilot-agent',
        );
    }

    public function testDisclosureHasNoPromptOrCompletionFields(): void
    {
        // Hard contract: the row never carries raw prompt or completion text.
        $r = new ReflectionClass(AgentDisclosure::class);

        $forbidden = ['prompt', 'completion', 'request_body', 'response_body', 'message', 'content', 'snapshot'];
        foreach ($r->getProperties() as $prop) {
            foreach ($forbidden as $needle) {
                self::assertStringNotContainsStringIgnoringCase(
                    $needle,
                    $prop->getName(),
                    "AgentDisclosure must not declare a property named like '{$needle}'",
                );
            }
        }
    }
}
