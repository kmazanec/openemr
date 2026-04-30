<?php

/**
 * Wiring tests for the Clinical Co-Pilot Bootstrap class.
 *
 * Verifies the patient-summary card entry point: when a `SectionEvent` is
 * dispatched for the `primary` section, the bootstrap listener adds the
 * "Open Co-Pilot" card; when it fires for any other section, the card is
 * not added. Also verifies that the Twig templates path is registered
 * onto a FilesystemLoader so the card template can resolve.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot;

use OpenEMR\Events\Core\TwigEnvironmentEvent;
use OpenEMR\Events\Patient\Summary\Card\CardInterface;
use OpenEMR\Events\Patient\Summary\Card\SectionEvent;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;
use Symfony\Component\EventDispatcher\EventDispatcher;
use Twig\Environment;
use Twig\Loader\FilesystemLoader;

#[Group('isolated')]
final class BootstrapTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../interface/modules/custom_modules/oe-module-clinical-copilot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_DIR . '/src/Bootstrap.php';
    }

    protected function tearDown(): void
    {
        unset($_SESSION['pid']);
    }

    #[Test]
    public function addsOpenCopilotCardOnPrimarySection(): void
    {
        $_SESSION['pid'] = '92';

        $dispatcher = new EventDispatcher();
        (new Bootstrap($dispatcher))->subscribeToEvents();

        $event = new SectionEvent('primary');
        $dispatcher->dispatch($event, SectionEvent::EVENT_HANDLE);

        $cards = $event->getCards();
        self::assertCount(1, $cards);
        $card = $cards[0];
        self::assertInstanceOf(CardInterface::class, $card);
        self::assertSame('clinical_copilot_open', $card->getIdentifier());
        self::assertSame(['patients', 'med'], $card->getAcl());
    }

    #[Test]
    public function leavesNonPrimarySectionsAlone(): void
    {
        $_SESSION['pid'] = '92';

        $dispatcher = new EventDispatcher();
        (new Bootstrap($dispatcher))->subscribeToEvents();

        $event = new SectionEvent('secondary');
        $dispatcher->dispatch($event, SectionEvent::EVENT_HANDLE);

        self::assertCount(0, $event->getCards());
    }

    #[Test]
    public function skipsCardWhenNoPatientInSession(): void
    {
        unset($_SESSION['pid']);

        $dispatcher = new EventDispatcher();
        (new Bootstrap($dispatcher))->subscribeToEvents();

        $event = new SectionEvent('primary');
        $dispatcher->dispatch($event, SectionEvent::EVENT_HANDLE);

        self::assertCount(0, $event->getCards());
    }

    #[Test]
    public function copilotCardLinksToPanelEntryWithCurrentPid(): void
    {
        $_SESSION['pid'] = '92';

        $dispatcher = new EventDispatcher();
        (new Bootstrap($dispatcher))->subscribeToEvents();

        $event = new SectionEvent('primary');
        $dispatcher->dispatch($event, SectionEvent::EVENT_HANDLE);

        $card = $event->getCards()[0];
        self::assertInstanceOf(CardInterface::class, $card);
        $vars = $card->getTemplateVariables();
        self::assertArrayHasKey('panelUrl', $vars);
        $panelUrl = $vars['panelUrl'];
        self::assertIsString($panelUrl);
        self::assertStringEndsWith(
            '/interface/modules/custom_modules/oe-module-clinical-copilot/public/panel.php?pid=92',
            $panelUrl,
        );
    }

    #[Test]
    public function prependsModuleTemplatesPathOnTwigEnvironmentCreate(): void
    {
        $loader = new FilesystemLoader([__DIR__]);
        $env = new Environment($loader);

        $dispatcher = new EventDispatcher();
        (new Bootstrap($dispatcher))->subscribeToEvents();
        $dispatcher->dispatch(new TwigEnvironmentEvent($env), TwigEnvironmentEvent::EVENT_CREATED);

        $paths = $loader->getPaths();
        $expectedPath = realpath(
            __DIR__ . '/../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/templates',
        );
        self::assertNotFalse($expectedPath, 'module templates dir not on disk');
        $resolved = array_map(static fn (string $p): string => realpath($p) ?: $p, $paths);
        self::assertContains($expectedPath, $resolved);
        // Prepended → first entry, so the module's templates take precedence.
        self::assertSame($expectedPath, $resolved[0]);
    }
}
