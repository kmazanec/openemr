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

use OpenEMR\Events\Core\ScriptFilterEvent;
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
    public function copilotCardAutoOpensTheTabWhenTheDashboardRenders(): void
    {
        // The card markup ships an inline script that opens the
        // co-pilot panel as a peer tab in the background whenever the
        // dashboard renders and no copilot tab is currently mounted.
        // Pin the contract:
        //   - early-return when an iframe[name=copilot] already
        //     exists (so a patient switch lets navigateTab refresh
        //     the existing tab in place rather than double-opening,
        //     and doesn't yank focus into the just-loaded co-pilot)
        //   - top.navigateTab is called WITHOUT activateTabByName,
        //     leaving the new tab in the background
        //   - no per-session "open once" gate — the panel re-mounts
        //     on every patient open, matching Visit History and the
        //     other peer tabs.
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

        self::assertStringContainsString('iframe[name="copilot"]', $html);
        self::assertStringContainsString('top.navigateTab(', $html);
        // Must NOT call activateTabByName from auto-open (would foreground).
        self::assertMatchesRegularExpression(
            '/top\.navigateTab\([^)]*,\s*[\'"]copilot[\'"]\s*\)/',
            $html,
            'auto-open should call navigateTab without an afterLoad callback so the new tab stays in the background',
        );
        // No once-per-session gate — closing the tab and switching to
        // a different patient (or the same patient) must reopen it.
        self::assertStringNotContainsString('sessionStorage', $html);
        self::assertStringNotContainsString('copilot_autoopened', $html);
    }

    #[Test]
    public function appendsScheduleShimToCalendarDayView(): void
    {
        // §5.4 boundary: only the calendar day/week view gets the
        // shim. The path must round-trip through `setScripts()`'s
        // safe-files filter (it requires the file exists on disk
        // under the modules tree), which is why the JS shim file is
        // committed alongside this listener.
        $GLOBALS['webroot'] ??= '';
        $GLOBALS['fileroot'] ??= dirname(__DIR__, 5);

        $dispatcher = new EventDispatcher();
        (new Bootstrap($dispatcher))->subscribeToEvents();

        $event = new ScriptFilterEvent('pnuserapi.php');
        $dispatcher->dispatch($event, ScriptFilterEvent::EVENT_NAME);

        $scripts = $event->getScripts();
        self::assertCount(1, $scripts);
        self::assertIsString($scripts[0]);
        self::assertStringEndsWith(
            '/interface/modules/custom_modules/oe-module-clinical-copilot/public/js/schedule-annotations.js',
            $scripts[0],
        );
    }

    #[Test]
    public function leavesAddEditEventDialogScriptsAlone(): void
    {
        // The add-edit dialog dispatches the same event but renders
        // no appointment list — injecting the shim would just be dead
        // weight on every appointment-edit modal.
        $GLOBALS['webroot'] ??= '';
        $GLOBALS['fileroot'] ??= dirname(__DIR__, 5);

        $dispatcher = new EventDispatcher();
        (new Bootstrap($dispatcher))->subscribeToEvents();

        $event = new ScriptFilterEvent('add_edit_event.php');
        $dispatcher->dispatch($event, ScriptFilterEvent::EVENT_NAME);

        self::assertSame([], $event->getScripts());
    }

    #[Test]
    public function leavesCalendarAdminScriptsAlone(): void
    {
        $GLOBALS['webroot'] ??= '';
        $GLOBALS['fileroot'] ??= dirname(__DIR__, 5);

        $dispatcher = new EventDispatcher();
        (new Bootstrap($dispatcher))->subscribeToEvents();

        $event = new ScriptFilterEvent('pnadmin.php');
        $dispatcher->dispatch($event, ScriptFilterEvent::EVENT_NAME);

        self::assertSame([], $event->getScripts());
    }

    #[Test]
    public function shimAppendsRatherThanReplacingPreexistingScripts(): void
    {
        // Other modules may already have appended scripts to this
        // event before us. Decoration, not displacement — the test
        // confirms a pre-seeded entry survives.
        $GLOBALS['webroot'] ??= '';
        $GLOBALS['fileroot'] ??= dirname(__DIR__, 5);

        $existingShim = '/interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js';

        $dispatcher = new EventDispatcher();
        (new Bootstrap($dispatcher))->subscribeToEvents();

        $event = new ScriptFilterEvent('pnuserapi.php');
        $event->setScripts([$existingShim]);
        $dispatcher->dispatch($event, ScriptFilterEvent::EVENT_NAME);

        $scripts = $event->getScripts();
        self::assertCount(2, $scripts);
        self::assertContains($existingShim, $scripts);
        self::assertIsString($scripts[1]);
        self::assertStringEndsWith(
            '/interface/modules/custom_modules/oe-module-clinical-copilot/public/js/schedule-annotations.js',
            $scripts[1],
        );
    }

    #[Test]
    public function shimIsAppendedOnlyOnce(): void
    {
        // Defensive: a misconfigured caller that fires the event twice
        // (or our listener wired twice) would otherwise inject two
        // identical <script> tags. The listener guards against that.
        $GLOBALS['webroot'] ??= '';
        $GLOBALS['fileroot'] ??= dirname(__DIR__, 5);

        $dispatcher = new EventDispatcher();
        (new Bootstrap($dispatcher))->subscribeToEvents();

        $event = new ScriptFilterEvent('pnuserapi.php');
        $dispatcher->dispatch($event, ScriptFilterEvent::EVENT_NAME);
        $dispatcher->dispatch($event, ScriptFilterEvent::EVENT_NAME);

        self::assertCount(1, $event->getScripts());
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
