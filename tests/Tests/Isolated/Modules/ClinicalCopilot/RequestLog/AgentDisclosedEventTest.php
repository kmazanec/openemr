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
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use Symfony\Contracts\EventDispatcher\Event;

final class AgentDisclosedEventTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/RequestLog';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_DIR . '/AgentDisclosure.php';
        require_once self::MODULE_DIR . '/AgentDisclosedEvent.php';
    }

    public function testEventCarriesTheDisclosure(): void
    {
        $d = $this->disclosure();
        $event = new AgentDisclosedEvent($d);
        self::assertSame($d, $event->getDisclosure());
    }

    public function testEventIsASymfonyEvent(): void
    {
        $r = new ReflectionClass(AgentDisclosedEvent::class);
        self::assertSame(Event::class, $r->getParentClass() === false ? null : $r->getParentClass()->getName());
    }

    public function testEventHandleIsStable(): void
    {
        // Listeners subscribe by this constant; pin via reflection so a
        // future rename is caught as a contract break rather than absorbed.
        $r = new ReflectionClass(AgentDisclosedEvent::class);
        self::assertSame('agent.phi.disclosed', $r->getConstant('EVENT_HANDLE'));
    }

    private function disclosure(): AgentDisclosure
    {
        return new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('2026-04-30T12:00:00+00:00'),
            actorUserId: 1,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/abc',
            siteId: 'default',
            patientPid: 5,
            patientUuid: null,
            conversationId: null,
            action: 'briefing',
            requestId: 'jti-1',
            categories: ['allergy', 'diagnosis'],
            destination: 'openemr-clinical-copilot-agent',
        );
    }
}
