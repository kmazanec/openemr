<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Cli;

use DateTimeImmutable;
use OpenEMR\Common\Command\AgentPrecomputeDayCommand;
use OpenEMR\Modules\ClinicalCopilot\Cli\PrecomputeRunner;
use OpenEMR\Modules\ClinicalCopilot\Cli\RunOptions;
use OpenEMR\Modules\ClinicalCopilot\Cli\RunSummary;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Tester\CommandTester;

require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Cli/RunOptions.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Cli/RunSummary.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Cli/PrecomputeRunner.php';
require_once __DIR__
    . '/../../../../../../src/Common/Command/AgentPrecomputeDayCommand.php';

final class AgentPrecomputeDayCommandTest extends TestCase
{
    public function testEmptyRunExitsSuccessAndPrintsTheSummary(): void
    {
        $runner = new RecordingRunner(new RunSummary(0, 0, 0, 0, 0, 0, 0));
        $tester = $this->build($runner);
        $tester->execute([]);
        $this->assertSame(Command::SUCCESS, $tester->getStatusCode());
        $this->assertStringContainsString('Precompute summary', $tester->getDisplay());
        $this->assertStringContainsString('practitionersConsidered', $tester->getDisplay());
    }

    public function testPartialFailureExitsSuccess(): void
    {
        $runner = new RecordingRunner(new RunSummary(1, 1, 3, 2, 0, 0, 1));
        $tester = $this->build($runner);
        $tester->execute([]);
        $this->assertSame(Command::SUCCESS, $tester->getStatusCode());
    }

    public function testFullDayFailureExitsFailure(): void
    {
        $runner = new RecordingRunner(new RunSummary(1, 1, 3, 0, 0, 0, 3));
        $tester = $this->build($runner);
        $tester->execute([]);
        $this->assertSame(Command::FAILURE, $tester->getStatusCode());
    }

    public function testForwardsForcePractitionerAndDryRunOptions(): void
    {
        $runner = new RecordingRunner(new RunSummary(0, 0, 0, 0, 0, 0, 0));
        $tester = $this->build($runner);
        $tester->execute([
            '--force' => true,
            '--practitioner' => '11111111-1111-1111-1111-111111111111',
            '--dry-run' => true,
            '--window-minutes' => '30',
        ]);
        $options = $runner->lastOptions;
        $this->assertNotNull($options);
        $this->assertTrue($options->force);
        $this->assertSame('11111111-1111-1111-1111-111111111111', $options->practitionerUuid);
        $this->assertTrue($options->dryRun);
        $this->assertSame(0, $options->window->h);
        $this->assertSame(30, $options->window->i);
    }

    public function testRejectsZeroWindowMinutes(): void
    {
        $runner = new RecordingRunner(new RunSummary(0, 0, 0, 0, 0, 0, 0));
        $tester = $this->build($runner);
        $tester->execute(['--window-minutes' => '0']);
        $this->assertSame(Command::INVALID, $tester->getStatusCode());
        $this->assertStringContainsString('--window-minutes must be a positive integer', $tester->getDisplay());
    }

    public function testFactoryFailureSurfacesAsCommandFailure(): void
    {
        $command = new AgentPrecomputeDayCommand(
            static function (): void {
                throw new \RuntimeException('AGENT_BASE_URL is not set');
            },
        );
        $tester = new CommandTester($command);
        $tester->execute([]);
        $this->assertSame(Command::FAILURE, $tester->getStatusCode());
        $this->assertStringContainsString('AGENT_BASE_URL is not set', $tester->getDisplay());
    }

    private function build(RecordingRunner $runner): CommandTester
    {
        $command = new AgentPrecomputeDayCommand(
            static fn(): PrecomputeRunner => $runner,
        );
        return new CommandTester($command);
    }
}

final class RecordingRunner implements PrecomputeRunner
{
    public ?RunOptions $lastOptions = null;
    public ?DateTimeImmutable $lastNow = null;

    public function __construct(private readonly RunSummary $summary)
    {
    }

    public function runForWindow(DateTimeImmutable $now, RunOptions $options): RunSummary
    {
        $this->lastNow = $now;
        $this->lastOptions = $options;
        return $this->summary;
    }
}
