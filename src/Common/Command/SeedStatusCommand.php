<?php

/**
 * SeedStatusCommand reports row counts and key health metrics for the
 * seeded dataset, so an operator can quickly verify what state an
 * environment's database is in.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Common\Command;

use OpenEMR\Common\Database\QueryUtils;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

class SeedStatusCommand extends Command
{
    /** @var array<string, string> table => human label */
    private const TABLES = [
        'patient_data' => 'patients',
        'form_encounter' => 'encounters',
        'form_vitals' => 'vitals records',
        'form_soap' => 'SOAP notes',
        'lists' => 'list items (problems/meds/allergies)',
        'prescriptions' => 'prescriptions',
        'procedure_order' => 'lab orders',
        'procedure_result' => 'lab results',
        'external_encounters' => 'outside encounters (CCDA)',
        'openemr_postcalendar_events' => 'calendar appointments',
        'users' => 'users',
    ];

    protected function configure(): void
    {
        $this
            ->setName('seed:status')
            ->setDescription('Report row counts and clinical-data coverage for the seeded dataset.');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        // Top-level table counts.
        $tableRows = [];
        foreach (self::TABLES as $table => $label) {
            $value = QueryUtils::fetchSingleValue(
                "SELECT COUNT(*) FROM `{$table}`",
                'COUNT(*)',
                []
            );
            $count = is_numeric($value) ? (int) $value : 0;
            $tableRows[] = [$table, number_format($count), $label];
        }
        $io->table(['table', 'rows', 'description'], $tableRows);

        // Clinical coverage (problem/allergy/vitals reach across the patient population).
        $patientCount = $this->scalar('SELECT COUNT(*) FROM patient_data WHERE pid > 0');
        if ($patientCount > 0) {
            $patientsWithProblems = $this->scalar("SELECT COUNT(DISTINCT pid) FROM lists WHERE type='medical_problem' AND activity=1");
            $patientsWithAllergies = $this->scalar("SELECT COUNT(DISTINCT pid) FROM lists WHERE type='allergy' AND activity=1");
            $patientsWithMeds = $this->scalar("SELECT COUNT(DISTINCT patient_id) FROM prescriptions WHERE active=1");
            $patientsWithVitals = $this->scalar('SELECT COUNT(DISTINCT pid) FROM form_vitals');
            $patientsWithLabs = $this->scalar('SELECT COUNT(DISTINCT patient_id) FROM procedure_order');
            $patientsWithSoap = $this->scalar('SELECT COUNT(DISTINCT pid) FROM form_soap');
            $patientsWithExt = $this->scalar('SELECT COUNT(DISTINCT ee_pid) FROM external_encounters');
            $patientsWithStoppedMeds = $this->scalar('SELECT COUNT(DISTINCT patient_id) FROM prescriptions WHERE active=0');
            $patientsWithRecentAbnormal = $this->scalar(
                "SELECT COUNT(DISTINCT po.patient_id)
                 FROM procedure_order po
                 JOIN procedure_report rep ON rep.procedure_order_id=po.procedure_order_id
                 JOIN procedure_result pr ON pr.procedure_report_id=rep.procedure_report_id
                 WHERE pr.abnormal IN ('high','low','yes')
                   AND po.date_collected >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)"
            );
            $io->table(['coverage', 'patients', '%'], [
                ['has problem entry', $patientsWithProblems, $this->pct($patientsWithProblems, $patientCount)],
                ['has allergy', $patientsWithAllergies, $this->pct($patientsWithAllergies, $patientCount)],
                ['has prescription', $patientsWithMeds, $this->pct($patientsWithMeds, $patientCount)],
                ['has stopped med', $patientsWithStoppedMeds, $this->pct($patientsWithStoppedMeds, $patientCount)],
                ['has vitals record', $patientsWithVitals, $this->pct($patientsWithVitals, $patientCount)],
                ['has lab order', $patientsWithLabs, $this->pct($patientsWithLabs, $patientCount)],
                ['has recent abnormal lab (<90d)', $patientsWithRecentAbnormal, $this->pct($patientsWithRecentAbnormal, $patientCount)],
                ['has SOAP note', $patientsWithSoap, $this->pct($patientsWithSoap, $patientCount)],
                ['has outside encounter', $patientsWithExt, $this->pct($patientsWithExt, $patientCount)],
            ]);
        }

        // PCP panel breakdown — useful for confirming Dr. Patel's panel skew.
        $panelRows = QueryUtils::fetchRecords(
            "SELECT COALESCE(u.username, '(unassigned)') AS pcp,
                    COALESCE(CONCAT(u.fname,' ',u.lname), '') AS name,
                    COUNT(*) AS patients
             FROM patient_data pd
             LEFT JOIN users u ON u.id = pd.providerID
             WHERE pd.pid > 0
             GROUP BY pcp, name
             ORDER BY patients DESC",
            []
        );
        $panelTable = [];
        foreach ($panelRows as $row) {
            $pcp = $row['pcp'] ?? '';
            $name = $row['name'] ?? '';
            $patients = $row['patients'] ?? 0;
            $panelTable[] = [
                is_string($pcp) ? $pcp : '',
                is_string($name) ? trim($name) : '',
                is_numeric($patients) ? (int) $patients : 0,
            ];
        }
        if ($panelTable !== []) {
            $io->table(['PCP', 'name', 'patients'], $panelTable);
        }

        // Calendar window: yesterday → +14 days.
        $apptToday = $this->scalar('SELECT COUNT(*) FROM openemr_postcalendar_events WHERE pc_eventDate = CURDATE()');
        $apptUpcoming = $this->scalar('SELECT COUNT(*) FROM openemr_postcalendar_events WHERE pc_eventDate > CURDATE() AND pc_eventDate <= DATE_ADD(CURDATE(), INTERVAL 14 DAY)');
        $apptPastWeek = $this->scalar('SELECT COUNT(*) FROM openemr_postcalendar_events WHERE pc_eventDate < CURDATE() AND pc_eventDate >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)');
        $io->table(['schedule window', 'count'], [
            ['past 7 days', $apptPastWeek],
            ['today', $apptToday],
            ['next 14 days', $apptUpcoming],
        ]);

        return Command::SUCCESS;
    }

    private function scalar(string $sql): int
    {
        $rows = QueryUtils::fetchRecords($sql, []);
        if ($rows === []) {
            return 0;
        }
        $value = reset($rows[0]);
        return is_numeric($value) ? (int) $value : 0;
    }

    private function pct(int $part, int $total): string
    {
        if ($total === 0) {
            return '0%';
        }
        return round(($part / $total) * 100) . '%';
    }
}
