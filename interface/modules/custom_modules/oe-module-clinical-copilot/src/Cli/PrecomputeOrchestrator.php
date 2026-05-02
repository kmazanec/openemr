<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Cli;

use DateInterval;
use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use OpenEMR\Modules\ClinicalCopilot\Settings\PractitionerSettings;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ScheduleAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\ScheduleSlot;
use Psr\Log\LoggerInterface;

/**
 * §5.3 morning-prep precompute orchestrator. Pure business logic;
 * deps injected via the constructor so it can run inside a Symfony
 * Console command, an isolated PHPUnit test, or a future scheduler
 * without changes.
 *
 * Responsibilities:
 *
 *   - Read the opted-in practitioner set from {@see SettingsRepository}.
 *   - Filter to those whose local prep time falls in the current
 *     cron tick's window (via {@see InWindowPredicate}).
 *   - For each in-window practitioner: mint a JWT (long-TTL,
 *     §5.3 decision), fetch their day's slots in-process via
 *     {@see ScheduleAdapter}, and POST one precompute envelope per
 *     slot to the agent service.
 *   - Aggregate per-slot outcomes into a {@see RunSummary} so the
 *     calling Console command can pick a sensible exit code.
 *
 * Cost-story compliance: opted-out practitioners get *zero* log
 * lines and zero token spend, which is what {@see PractitionerSettings::$morningPrepEnabled}
 * being filtered at the SQL boundary already ensures — we don't even
 * iterate them. Out-of-window opted-in practitioners log a debug
 * line (a single counter increment on `practitionersConsidered`)
 * because the operator may want to audit "why didn't this run?"
 * during a cron-tuning session; that line carries no PHI.
 */
final readonly class PrecomputeOrchestrator implements PrecomputeRunner
{
    public function __construct(
        private PractitionerProvider $settings,
        private InWindowPredicate $inWindow,
        private ScheduleAdapter $scheduleAdapter,
        private AgentTokenMinter $tokenMinter,
        private PolicyGate $policyGate,
        private BriefingHttpClient $http,
        private LoggerInterface $logger,
        private RequestIdGenerator $requestIds,
        private string $agentBaseUrl,
        private string $issuer,
        private string $fhirBaseUrl,
        private string $siteId,
    ) {
    }

    public function runForWindow(DateTimeImmutable $now, RunOptions $options): RunSummary
    {
        $practitioners = $this->settings->findEnabledPractitioners();
        if ($options->practitionerUuid !== null) {
            $practitioners = array_values(array_filter(
                $practitioners,
                static fn(PractitionerSettings $s): bool
                    => $s->practitionerUuid === $options->practitionerUuid,
            ));
        }

        $practitionersConsidered = count($practitioners);
        $practitionersInWindow = 0;
        $slotsAttempted = 0;
        $slotsWritten = 0;
        $slotsOverwritten = 0;
        $slotsSkippedIdempotent = 0;
        $slotsErrored = 0;

        foreach ($practitioners as $practitioner) {
            if (!($this->inWindow)($practitioner, $now, $options->window)) {
                continue;
            }
            $practitionersInWindow += 1;

            $localToday = $now
                ->setTimezone(new \DateTimeZone($practitioner->timezone))
                ->format('Y-m-d');

            try {
                $slots = $this->scheduleAdapter->fetchSchedule(
                    $practitioner->practitionerUuid,
                    new DateTimeImmutable($localToday),
                );
            } catch (\RuntimeException | \DomainException | \Doctrine\DBAL\Exception $e) {
                // Same exception-shape the snapshot/Schedule controllers
                // catch (`AgentSnapshotController.php`). Narrow rather
                // than \Throwable so an `\Error` from a genuine bug
                // surfaces instead of being silently logged.
                $this->logger->error(
                    'precompute schedule fetch failed; skipping practitioner',
                    [
                        'practitionerUuid' => $practitioner->practitionerUuid,
                        'date' => $localToday,
                        'exception' => $e,
                    ],
                );
                continue;
            }

            if (count($slots) === 0) {
                $this->logger->info(
                    'precompute: practitioner has no slots today',
                    [
                        'practitionerUuid' => $practitioner->practitionerUuid,
                        'date' => $localToday,
                    ],
                );
                continue;
            }

            $token = $this->mintTokenFor($practitioner);

            foreach ($slots as $slot) {
                $slotsAttempted += 1;
                if ($options->dryRun) {
                    $this->logger->info(
                        'precompute: dry-run, would post slot',
                        [
                            'practitionerUuid' => $practitioner->practitionerUuid,
                            'appointmentId' => $slot->appointmentId,
                        ],
                    );
                    continue;
                }
                $outcome = $this->postSlot($practitioner, $slot, $token, $options);
                if ($outcome === null) {
                    $slotsErrored += 1;
                    continue;
                }
                switch ($outcome) {
                    case 'inserted':
                        $slotsWritten += 1;
                        break;
                    case 'overwritten':
                        $slotsOverwritten += 1;
                        break;
                    case 'skipped_idempotent':
                        $slotsSkippedIdempotent += 1;
                        break;
                    default:
                        // Unknown outcome — count as errored so the
                        // operator notices a contract drift between
                        // agent and orchestrator.
                        $slotsErrored += 1;
                        $this->logger->warning(
                            'precompute: unknown outcome from agent',
                            [
                                'practitionerUuid' => $practitioner->practitionerUuid,
                                'appointmentId' => $slot->appointmentId,
                                'outcome' => $outcome,
                            ],
                        );
                        break;
                }
            }
        }

        $summary = new RunSummary(
            practitionersConsidered: $practitionersConsidered,
            practitionersInWindow: $practitionersInWindow,
            slotsAttempted: $slotsAttempted,
            slotsWritten: $slotsWritten,
            slotsOverwritten: $slotsOverwritten,
            slotsSkippedIdempotent: $slotsSkippedIdempotent,
            slotsErrored: $slotsErrored,
        );
        $this->logger->info('precompute: run complete', $summary->toLogContext());
        return $summary;
    }

    private function mintTokenFor(PractitionerSettings $practitioner): string
    {
        $fhirUser = new ResolvedFhirUser(
            uuid: $practitioner->practitionerUuid,
            fhirUserUri: rtrim($this->fhirBaseUrl, '/')
                . '/Practitioner/' . $practitioner->practitionerUuid,
        );
        $scopes = $this->policyGate->defaultScopesFor('briefing');
        return $this->tokenMinter->mint(
            $fhirUser,
            $scopes,
            $this->issuer,
            new DateInterval('PT30M'),
        );
    }

    private function postSlot(
        PractitionerSettings $practitioner,
        ScheduleSlot $slot,
        string $token,
        RunOptions $options,
    ): ?string {
        $requestId = $this->requestIds->generate();
        $envelope = [
            'conversationId' => $requestId,
            'requestId' => $requestId,
            'siteId' => $this->siteId,
            'patient' => ['pid' => $slot->pid, 'uuid' => ''],
            'task' => 'default_briefing',
            'precompute' => true,
            'practitionerUuid' => $practitioner->practitionerUuid,
            'appointmentId' => $slot->appointmentId,
            'force' => $options->force,
        ];
        $url = rtrim($this->agentBaseUrl, '/') . '/v1/agent/briefing';
        try {
            $outcome = $this->http->postBriefing($url, $token, $envelope);
        } catch (BriefingHttpException $e) {
            $this->logger->error(
                'precompute: agent briefing call failed',
                [
                    'practitionerUuid' => $practitioner->practitionerUuid,
                    'appointmentId' => $slot->appointmentId,
                    'requestId' => $requestId,
                    'status' => $e->status,
                    'errorCode' => $e->errorCode,
                ],
            );
            return null;
        }
        $this->logger->info(
            'precompute: slot done',
            [
                'practitionerUuid' => $practitioner->practitionerUuid,
                'appointmentId' => $slot->appointmentId,
                'requestId' => $requestId,
                'outcome' => $outcome->precomputeOutcome,
            ],
        );
        return $outcome->precomputeOutcome;
    }
}
