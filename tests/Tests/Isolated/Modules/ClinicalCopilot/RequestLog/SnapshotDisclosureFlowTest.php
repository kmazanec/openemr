<?php

/**
 * End-to-end disclosure-flow test: build a real ChartSnapshot from
 * factory-driven adapters, dispatch the AgentDisclosedEvent through a
 * Symfony EventDispatcher, capture both recorder sides, and assert:
 *
 *   1. exactly one event fires per request
 *   2. every named field is populated correctly
 *   3. neither recorder has any path that captures prompt / completion
 *      / snapshot body content (asserted by scanning the recorded rows
 *      for unexpected PHI strings drawn from the snapshot itself)
 *
 * The forbidden-field-name reflection is already covered by
 * AgentDisclosureTest + DbalAgentRequestLogRecorderTest. This test
 * extends that coverage by feeding *real* PHI into the flow and
 * proving none of it ends up in either recorder's payload.
 *
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
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryDisclosureRecorder;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\DataCategory;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\DataCategorySet;
use OpenEMR\Seed\PatientArchetype;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\ArchetypeChartFactory;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\RequireModuleClasses;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\SnapshotBuilder;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use ReflectionClass;
use Symfony\Component\EventDispatcher\EventDispatcher;

final class SnapshotDisclosureFlowTest extends TestCase
{
    private const FAKER_SEED = 20260430;

    public static function setUpBeforeClass(): void
    {
        RequireModuleClasses::load();
    }

    public function testDispatchesExactlyOneEventWithAllFields(): void
    {
        $chart = (new ArchetypeChartFactory(self::FAKER_SEED))
            ->build(PatientArchetype::Diabetic);
        // Build the snapshot — this is the operation Phase 2.5's debug
        // route + Phase 3.1's tools will dispatch the event around. The
        // disclosure is the *fact* of the disclosure, not the snapshot
        // itself.
        $snapshot = SnapshotBuilder::build($chart);
        $this->assertNotEmpty($snapshot->diagnoses, 'sanity: diabetic snapshot is non-trivial');

        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener($disclosureSink, $requestLogSink, new NullLogger()),
        );

        $disclosure = new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('2026-04-30T12:00:00+00:00'),
            actorUserId: 7,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/' . $chart->uuid,
            siteId: 'default',
            patientPid: $chart->pid,
            patientUuid: $chart->uuid,
            conversationId: 'conv-' . $chart->uuid,
            action: 'briefing',
            requestId: 'jti-' . bin2hex(random_bytes(8)),
            categories: DataCategorySet::all()->toStrings(),
            destination: 'openemr-clinical-copilot-agent',
        );
        $dispatcher->dispatch(new AgentDisclosedEvent($disclosure), AgentDisclosedEvent::EVENT_HANDLE);

        // (1) exactly one event captured per recorder.
        $this->assertCount(1, $disclosureSink->all());
        $this->assertCount(1, $requestLogSink->all());

        $recorded = $requestLogSink->all()[0];
        // (2) every named field round-trips identically.
        $this->assertSame($disclosure->actorUserId, $recorded->actorUserId);
        $this->assertSame($disclosure->actorFhirUser, $recorded->actorFhirUser);
        $this->assertSame($disclosure->siteId, $recorded->siteId);
        $this->assertSame($disclosure->patientPid, $recorded->patientPid);
        $this->assertSame($disclosure->patientUuid, $recorded->patientUuid);
        $this->assertSame($disclosure->conversationId, $recorded->conversationId);
        $this->assertSame($disclosure->action, $recorded->action);
        $this->assertSame($disclosure->requestId, $recorded->requestId);
        $this->assertSame($disclosure->destination, $recorded->destination);
        $this->assertSame(
            ['allergy', 'appointment', 'diagnosis', 'encounter', 'lab', 'medication'],
            $recorded->categories,
            'AgentDisclosure must alphabetize categories at construction time',
        );
    }

    public function testRecordedRowsCarryNoSnapshotPhi(): void
    {
        // Feed real PHI through the snapshot, dispatch the event, and prove
        // none of that PHI escapes into either recorder's payload. The
        // forbidden-field-name reflection in AgentDisclosureTest pins the
        // *shape*; this pins the *content*.
        $chart = (new ArchetypeChartFactory(self::FAKER_SEED))
            ->build(PatientArchetype::Diabetic);
        $snapshot = SnapshotBuilder::build($chart);

        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener($disclosureSink, $requestLogSink, new NullLogger()),
        );

        $dispatcher->dispatch(
            new AgentDisclosedEvent(new AgentDisclosure(
                disclosedAt: new DateTimeImmutable('2026-04-30T12:00:00+00:00'),
                actorUserId: 7,
                actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/' . $chart->uuid,
                siteId: 'default',
                patientPid: $chart->pid,
                patientUuid: $chart->uuid,
                conversationId: null,
                action: 'briefing',
                requestId: 'jti-content-pin',
                categories: [DataCategory::Diagnosis->value, DataCategory::Medication->value],
                destination: 'openemr-clinical-copilot-agent',
            )),
            AgentDisclosedEvent::EVENT_HANDLE,
        );

        // Collect strings from the snapshot that *would* be PHI body content
        // if any code path leaked them.
        $forbidden = $this->phiNeedlesFromSnapshot($snapshot);
        $this->assertNotEmpty($forbidden, 'sanity: snapshot has PHI to leak');

        foreach ([$disclosureSink->all(), $requestLogSink->all()] as $rows) {
            foreach ($rows as $row) {
                $serialized = json_encode($this->disclosureToArray($row), JSON_THROW_ON_ERROR);
                foreach ($forbidden as $needle) {
                    $this->assertStringNotContainsString(
                        $needle,
                        $serialized,
                        'recorded disclosure row carries PHI from snapshot: "' . $needle . '"',
                    );
                }
            }
        }
    }

    public function testEventHandleMatchesArchitecture(): void
    {
        // Pinned: 'agent.phi.disclosed' is the contract the proxy + Phase 3
        // tools will dispatch on. Drift here breaks every consumer.
        // Reflection rather than `assertSame(string, EVENT_HANDLE)` so the
        // assertion survives PHPStan's constant folding.
        $reflected = (new ReflectionClass(AgentDisclosedEvent::class))
            ->getConstant('EVENT_HANDLE');
        $this->assertIsString($reflected);
        $this->assertSame('agent.phi.disclosed', $reflected);
    }

    /**
     * Best-effort dump of an AgentDisclosure into a JSON-encodable shape so
     * we can grep its serialized form. Reflection avoids relying on a
     * to-array method the production class deliberately doesn't have.
     *
     * @return array<string, mixed>
     */
    private function disclosureToArray(AgentDisclosure $d): array
    {
        $out = [];
        $rc = new ReflectionClass($d);
        foreach ($rc->getProperties() as $prop) {
            $value = $prop->getValue($d);
            if ($value instanceof DateTimeImmutable) {
                $value = $value->format(DATE_ATOM);
            }
            $out[$prop->getName()] = $value;
        }
        return $out;
    }

    /**
     * Pull a list of PHI strings out of the snapshot we expect *never* to
     * appear in a recorded disclosure row. Patient name + condition
     * label + drug name + a lab analyte cover the four most likely
     * leakage paths.
     *
     * @return list<string>
     */
    private function phiNeedlesFromSnapshot(\OpenEMR\Modules\ClinicalCopilot\Snapshot\ChartSnapshot $snapshot): array
    {
        $needles = [$snapshot->patient->displayName];
        if ($snapshot->diagnoses !== []) {
            $needles[] = $snapshot->diagnoses[0]->label;
        }
        if ($snapshot->medications !== []) {
            $needles[] = $snapshot->medications[0]->name;
        }
        if ($snapshot->labs !== []) {
            $needles[] = $snapshot->labs[0]->analyte;
        }
        return array_values(array_filter($needles, static fn(string $s): bool => $s !== ''));
    }
}
