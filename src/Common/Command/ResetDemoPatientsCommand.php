<?php

/**
 * ResetDemoPatientsCommand restores the four FixturePatient demo
 * patients (Chen / Whitaker / Reyes / Kowalski) to a known
 * demoable state by:
 *
 *   1. Looking up each fixture's current PID by (lname, DOB).
 *   2. Hard-deleting every per-patient row from the OpenEMR MySQL
 *      database — mirrors interface/patient_file/deleter.php's
 *      patient-delete branch (forms, encounters, lists, prescriptions,
 *      labs, calendar events, documents soft-delete, patient_data).
 *   3. Re-running seed:patients --fixtures-only and
 *      seed:schedule --fixtures-only to recreate the patients with
 *      their archetype-driven clinical scaffolding and weekly
 *      appointment recurrence.
 *   4. Booking one fresh next-business-day appointment per patient
 *      with their PCP.
 *
 * The companion db/seeds/reset-demo-patients.sh wraps this command
 * with a psql call that wipes the agent Postgres conversation /
 * extraction-artifact rows for the *old* PIDs (looked up before this
 * command runs). PIDs change on every reset because patient_data.pid
 * is auto-increment; the agent-side wipe must therefore run before
 * the OpenEMR-side delete.
 *
 * This command itself does not touch the agent Postgres database —
 * keeping the cross-database concern in the shell wrapper avoids
 * forcing this PHP process to know the agent's connection string.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Common\Command;

use Faker\Factory as FakerFactory;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Session\SessionUtil;
use OpenEMR\Seed\FixturePatient;
use OpenEMR\Seed\Generators\AppointmentGenerator;
use OpenEMR\Seed\Generators\VisitReasonPicker;
use OpenEMR\Services\AppointmentService;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\ArrayInput;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

class ResetDemoPatientsCommand extends Command
{
    private const DEFAULT_PCP_USERNAME = 'physician';

    /**
     * Slots for the four next-business-day appointments. One per
     * fixture patient, staggered 30 minutes apart so they show up
     * as a clean morning block on the calendar.
     */
    private const NEXT_DAY_SLOTS = [
        '09:00:00',
        '09:30:00',
        '10:00:00',
        '10:30:00',
    ];

    protected function configure(): void
    {
        $this
            ->setName('demo:reset-patients')
            ->setDescription('Hard-reset the four fixture demo patients: delete + re-seed + book next-business-day appointments.')
            ->addOption(
                'skip-reseed',
                null,
                InputOption::VALUE_NONE,
                'Only delete; do not re-run seed:patients/seed:schedule. Useful when the wrapper script is driving the seed steps.',
            )
            ->addOption(
                'skip-next-day-appt',
                null,
                InputOption::VALUE_NONE,
                'Skip the four next-business-day appointment inserts (the seed:schedule --fixtures-only run already includes them as week 1).',
            )
            ->addOption(
                'print-pids',
                null,
                InputOption::VALUE_NONE,
                'Before deleting, print one space-separated line of the current fixture PIDs and exit 0 without making changes. Used by the wrapper script to stage the agent-DB wipe.',
            );
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        $existing = [];
        foreach (FixturePatient::cases() as $fixture) {
            $pid = $this->lookupFixturePid($fixture);
            if ($pid !== null) {
                $existing[$fixture->value] = $pid;
            }
        }

        if ((bool) $input->getOption('print-pids')) {
            $output->writeln(implode(' ', array_values($existing)));
            return Command::SUCCESS;
        }

        $io->title('Resetting demo patients');

        if ($existing === []) {
            $io->note('No existing fixture patients found — nothing to delete.');
        } else {
            $io->section('Deleting existing fixture patients');
            foreach ($existing as $key => $pid) {
                $io->writeln(sprintf('  · %s (pid=%d)', $key, $pid));
                $this->deletePatient($pid);
            }
            $io->success(sprintf('Deleted %d fixture patient(s).', count($existing)));
        }

        if (!(bool) $input->getOption('skip-reseed')) {
            $io->section('Re-seeding fixture patients');
            $code = $this->invokeChild('seed:patients', ['--fixtures-only' => true], $output);
            if ($code !== Command::SUCCESS) {
                $io->error('seed:patients --fixtures-only failed.');
                return $code;
            }

            $io->section('Re-seeding fixture-patient weekly appointments');
            $code = $this->invokeChild('seed:schedule', ['--fixtures-only' => true], $output);
            if ($code !== Command::SUCCESS) {
                $io->error('seed:schedule --fixtures-only failed.');
                return $code;
            }
        } else {
            $io->note('--skip-reseed: not running seed:patients / seed:schedule.');
        }

        if (!(bool) $input->getOption('skip-next-day-appt')) {
            $io->section('Booking next-business-day appointments');
            $booked = $this->bookNextBusinessDayAppointments($io);
            $io->success(sprintf('Booked %d next-business-day appointment(s).', $booked));
        } else {
            $io->note('--skip-next-day-appt: not booking the dedicated next-business-day appointments.');
        }

        $io->success('Demo patient reset complete.');
        return Command::SUCCESS;
    }

    private function lookupFixturePid(FixturePatient $fixture): ?int
    {
        $row = QueryUtils::fetchSingleValue(
            'SELECT pid FROM patient_data WHERE lname = ? AND DOB = ? LIMIT 1',
            'pid',
            [$fixture->lastName(), $fixture->dateOfBirth()],
        );
        return is_numeric($row) && (int) $row > 0 ? (int) $row : null;
    }

    /**
     * Mirrors interface/patient_file/deleter.php's patient branch
     * (lines 218-252 as of writing). Kept as a single method here so
     * a future change to the deleter.php cascade is easy to spot in
     * a diff against this file.
     *
     * Differences vs. the UI deleter:
     *   - No ACL / allow_pat_delete check (this command only runs from
     *     the CLI, where ACL has no meaningful principal).
     *   - No EventAuditLogger calls (those need an active web session).
     *   - drug_sales: same restock-then-delete logic.
     */
    private function deletePatient(int $pid): void
    {
        // Deactivate (soft) — match deleter.php semantics.
        QueryUtils::sqlStatementThrowException(
            'UPDATE billing SET activity = 0 WHERE pid = ?',
            [$pid],
        );
        QueryUtils::sqlStatementThrowException(
            'UPDATE pnotes SET deleted = 1 WHERE pid = ?',
            [$pid],
        );
        QueryUtils::sqlStatementThrowException(
            'UPDATE ar_activity SET deleted = NOW() WHERE pid = ? AND deleted IS NULL',
            [$pid],
        );

        // Drug sales: restock inventory before deleting the rows.
        QueryUtils::sqlStatementThrowException(
            'UPDATE drug_sales AS ds, drug_inventory AS di '
            . 'SET di.on_hand = di.on_hand + ds.quantity '
            . 'WHERE ds.pid = ? AND ds.encounter != 0 AND di.inventory_id = ds.inventory_id',
            [$pid],
        );
        QueryUtils::sqlStatementThrowException('DELETE FROM drug_sales WHERE pid = ?', [$pid]);

        // Hard deletes.
        $tables = [
            'prescriptions'                 => 'patient_id = ?',
            'claims'                        => 'patient_id = ?',
            'payments'                      => 'pid = ?',
            'openemr_postcalendar_events'   => 'pc_pid = ?',
            'immunizations'                 => 'patient_id = ?',
            'issue_encounter'               => 'pid = ?',
            'lists'                         => 'pid = ?',
            'transactions'                  => 'pid = ?',
            'employer_data'                 => 'pid = ?',
            'history_data'                  => 'pid = ?',
            'insurance_data'                => 'pid = ?',
            'patient_history'               => 'pid = ?',
        ];
        foreach ($tables as $table => $where) {
            QueryUtils::sqlStatementThrowException(
                "DELETE FROM `{$table}` WHERE {$where}",
                [$pid],
            );
        }

        // Forms + encounters: walk forms first to clear their per-form
        // tables, then nuke form_encounter for the patient. This is
        // best-effort — for richly-formed encounters the original
        // form_delete() helper does per-formdir cleanup we don't
        // replicate here, but the seed pipeline only ever creates
        // form_soap rows so DELETE-by-pid covers it.
        QueryUtils::sqlStatementThrowException(
            'DELETE FROM forms WHERE pid = ?',
            [$pid],
        );
        QueryUtils::sqlStatementThrowException(
            'DELETE FROM form_encounter WHERE pid = ?',
            [$pid],
        );
        QueryUtils::sqlStatementThrowException(
            'DELETE FROM form_soap WHERE pid = ?',
            [$pid],
        );
        QueryUtils::sqlStatementThrowException(
            'DELETE FROM form_vitals WHERE pid = ?',
            [$pid],
        );

        // Procedure (lab) cascade: orders → reports → results.
        $orderRows = QueryUtils::fetchRecords(
            'SELECT procedure_order_id FROM procedure_order WHERE patient_id = ?',
            [$pid],
        );
        foreach ($orderRows as $row) {
            $orderId = isset($row['procedure_order_id']) && is_numeric($row['procedure_order_id'])
                ? (int) $row['procedure_order_id']
                : 0;
            if ($orderId === 0) {
                continue;
            }
            $reportRows = QueryUtils::fetchRecords(
                'SELECT procedure_report_id FROM procedure_report WHERE procedure_order_id = ?',
                [$orderId],
            );
            foreach ($reportRows as $reportRow) {
                $reportId = isset($reportRow['procedure_report_id']) && is_numeric($reportRow['procedure_report_id'])
                    ? (int) $reportRow['procedure_report_id']
                    : 0;
                if ($reportId !== 0) {
                    QueryUtils::sqlStatementThrowException(
                        'DELETE FROM procedure_result WHERE procedure_report_id = ?',
                        [$reportId],
                    );
                }
            }
            QueryUtils::sqlStatementThrowException(
                'DELETE FROM procedure_report WHERE procedure_order_id = ?',
                [$orderId],
            );
            QueryUtils::sqlStatementThrowException(
                'DELETE FROM procedure_order_code WHERE procedure_order_id = ?',
                [$orderId],
            );
        }
        QueryUtils::sqlStatementThrowException(
            'DELETE FROM procedure_order WHERE patient_id = ?',
            [$pid],
        );

        // External (outside) encounters added by SeedPatientsCommand.
        QueryUtils::sqlStatementThrowException(
            'DELETE FROM external_encounters WHERE ee_pid = ?',
            [$pid],
        );

        // Documents: soft-delete (same as deleter.php — files stay on
        // disk for ONC-cert compliance) plus removal of category
        // links and gprelations.
        $docRows = QueryUtils::fetchRecords(
            'SELECT id FROM documents WHERE foreign_id = ? AND deleted = 0',
            [$pid],
        );
        foreach ($docRows as $row) {
            $docId = isset($row['id']) && is_numeric($row['id']) ? (int) $row['id'] : 0;
            if ($docId === 0) {
                continue;
            }
            QueryUtils::sqlStatementThrowException(
                'UPDATE documents SET deleted = 1 WHERE id = ?',
                [$docId],
            );
            QueryUtils::sqlStatementThrowException(
                'DELETE FROM categories_to_documents WHERE document_id = ?',
                [$docId],
            );
            QueryUtils::sqlStatementThrowException(
                'DELETE FROM gprelations WHERE type1 = 1 AND id1 = ?',
                [$docId],
            );
        }

        // Finally, the patient row itself.
        QueryUtils::sqlStatementThrowException(
            'DELETE FROM patient_data WHERE pid = ?',
            [$pid],
        );
    }

    /**
     * @param array<string, scalar|bool> $args
     */
    private function invokeChild(string $name, array $args, OutputInterface $output): int
    {
        $app = $this->getApplication();
        if ($app === null) {
            throw new \RuntimeException('Cannot invoke child command without a Symfony Application.');
        }
        $cmd = $app->find($name);
        $childArgs = ['command' => $name];
        foreach ($args as $key => $value) {
            $childArgs[$key] = $value;
        }
        return $cmd->run(new ArrayInput($childArgs), $output);
    }

    private function bookNextBusinessDayAppointments(SymfonyStyle $io): int
    {
        $pcpId = $this->loadDefaultPcpId();
        if ($pcpId === null) {
            $io->warning('Default PCP user not found — skipping next-business-day appointments.');
            return 0;
        }

        // AppointmentService reads authUserID from session for pc_informant.
        SessionUtil::setSession('authUserID', $pcpId);

        $faker = FakerFactory::create('en_US');
        $reasonPicker = new VisitReasonPicker($faker);
        $generator = new AppointmentGenerator($reasonPicker);
        $service = new AppointmentService();

        $date = $this->nextBusinessDay(new \DateTimeImmutable('today'))->format('Y-m-d');

        $cases = FixturePatient::cases();
        $count = min(count($cases), count(self::NEXT_DAY_SLOTS));
        $booked = 0;

        for ($i = 0; $i < $count; $i++) {
            $fixture = $cases[$i];
            $pid = $this->lookupFixturePid($fixture);
            if ($pid === null) {
                $io->warning(sprintf('Fixture %s missing post-reseed — cannot book.', $fixture->value));
                continue;
            }
            $payload = $generator->generate(
                $fixture->archetype(),
                $pcpId,
                $date,
                self::NEXT_DAY_SLOTS[$i],
                '-',
            );
            try {
                $insertId = $service->insert($pid, $payload);
                if ($insertId) {
                    $booked++;
                    $eidLabel = is_scalar($insertId) ? (string) $insertId : '?';
                    $io->writeln(sprintf(
                        '  · %s @ %s %s (pid=%d, eid=%s)',
                        $fixture->value,
                        $date,
                        self::NEXT_DAY_SLOTS[$i],
                        $pid,
                        $eidLabel,
                    ));
                }
            } catch (\RuntimeException | \InvalidArgumentException $e) {
                $io->warning(sprintf('Failed to book %s: %s', $fixture->value, $e->getMessage()));
            }
        }
        return $booked;
    }

    private function nextBusinessDay(\DateTimeImmutable $from): \DateTimeImmutable
    {
        $cursor = $from;
        while ((int) $cursor->format('N') >= 6) {
            $cursor = $cursor->modify('+1 day');
        }
        return $cursor;
    }

    private function loadDefaultPcpId(): ?int
    {
        $row = QueryUtils::fetchSingleValue(
            'SELECT id FROM users WHERE username = ? AND active = 1 LIMIT 1',
            'id',
            [self::DEFAULT_PCP_USERNAME],
        );
        return is_numeric($row) && (int) $row > 0 ? (int) $row : null;
    }
}
