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
use Twig\Loader\ArrayLoader;
use Twig\Loader\ChainLoader;
use Twig\Loader\FilesystemLoader;
use Twig\TwigFilter;

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
    public function copilotCardOpensPanelAsAPeerTabRatherThanReplacingTheIframe(): void
    {
        // The card lives inside the patient-data iframe but the
        // OpenEMR tabs view-model is on the parent window. Clicking
        // "Open Co-Pilot" must call top.navigateTab + activateTabByName
        // so the panel opens as a peer tab (alongside Calendar,
        // Dashboard, Visit History) instead of replacing the current
        // iframe content. The href is preserved as a graceful
        // fallback for contexts where the tab system isn't loaded.
        $arrayLoader = new ArrayLoader([
            // Stub parent that simply renders the child's content block
            // — exercises the real copilot.html.twig without dragging
            // in card_base's full filter chain.
            'patient/card/card_base.html.twig' => '{% block content %}{% endblock %}',
        ]);
        $filesystemLoader = new FilesystemLoader([self::MODULE_DIR . '/templates']);
        $loader = new ChainLoader([$filesystemLoader, $arrayLoader]);
        $env = new Environment($loader, ['autoescape' => 'html']);
        // OpenEMR's runtime registers `|xlt`, `|attr`, `|text` via
        // TwigExtension; pass-through with HTML escaping here so the
        // template compiles without the production stack.
        $passthrough = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES);
        $env->addFilter(new TwigFilter('xlt', $passthrough));
        $env->addFilter(new TwigFilter('attr', $passthrough));
        $env->addFilter(new TwigFilter('text', $passthrough));

        $html = $env->render('card/copilot.html.twig', [
            'panelUrl' => '/interface/modules/custom_modules/oe-module-clinical-copilot/public/panel.php?pid=92',
        ]);

        // Must call into the parent window's tab system.
        self::assertStringContainsString('top.navigateTab', $html);
        self::assertStringContainsString("'copilot'", $html);
        self::assertStringContainsString('top.activateTabByName', $html);
        self::assertStringContainsString('top.restoreSession()', $html);
        // Onclick returns false so the anchor's same-window navigation
        // is suppressed when the tab system is available; href stays
        // present as a fallback.
        self::assertStringContainsString('return false', $html);
        self::assertStringContainsString(
            'href="/interface/modules/custom_modules/oe-module-clinical-copilot/public/panel.php?pid=92"',
            $html,
        );
        self::assertStringContainsString('data-role="open-copilot"', $html);
    }

    #[Test]
    public function copilotCardAutoOpensTheTabOncePerSessionWhenTheDashboardRenders(): void
    {
        // The card markup ships an inline script that opens the
        // co-pilot panel as a peer tab in the background the first
        // time the dashboard renders. Pin the contract:
        //   - sessionStorage flag prevents repeat opens within a
        //     session (so closing the tab on purpose is honored)
        //   - early-return when an iframe[name=copilot] already
        //     exists (so a patient switch doesn't yank focus into the
        //     just-loaded co-pilot)
        //   - top.navigateTab is called WITHOUT activateTabByName,
        //     leaving the new tab in the background.
        $arrayLoader = new ArrayLoader([
            'patient/card/card_base.html.twig' => '{% block content %}{% endblock %}',
        ]);
        $filesystemLoader = new FilesystemLoader([self::MODULE_DIR . '/templates']);
        $loader = new ChainLoader([$filesystemLoader, $arrayLoader]);
        $env = new Environment($loader, ['autoescape' => 'html']);
        $passthrough = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES);
        $env->addFilter(new TwigFilter('xlt', $passthrough));
        $env->addFilter(new TwigFilter('attr', $passthrough));
        $env->addFilter(new TwigFilter('text', $passthrough));

        $html = $env->render('card/copilot.html.twig', [
            'panelUrl' => '/interface/modules/custom_modules/oe-module-clinical-copilot/public/panel.php?pid=92',
        ]);

        self::assertStringContainsString('copilot_autoopened', $html);
        self::assertStringContainsString('iframe[name="copilot"]', $html);
        self::assertStringContainsString('top.navigateTab(', $html);
        // Must NOT call activateTabByName from auto-open (would foreground).
        self::assertMatchesRegularExpression(
            '/top\.navigateTab\([^)]*,\s*[\'"]copilot[\'"]\s*\)/',
            $html,
            'auto-open should call navigateTab without an afterLoad callback so the new tab stays in the background',
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
